import { Hono } from "hono";
import { UploadPhotoFields } from "@keepsake/contracts/photo";
import type { Env } from "../env.js";
import { parseIntVar } from "../env.js";
import { ok, fail } from "../lib/respond.js";
import { ulid } from "../lib/ids.js";
import { extensionForSniffedType, sniffImageType } from "../lib/imageSniff.js";
import { requireParam } from "../lib/params.js";
import { ownerAuth, type OwnerRow } from "../middleware/ownerAuth.js";
import { burst, dailyBudget } from "../middleware/rateLimit.js";
import { checkAndBump, clientIPFrom } from "../moderation/budget.js";
import { suggestFromPhoto } from "../suggest/suggest.js";

type Vars = { owner: OwnerRow };
export const photoRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

const DEFAULT_MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const DEFAULT_UPLOAD_IP_DAILY_BUDGET = 60;
// Global ceiling far past what a real day of givers reaches (~15 neurons per
// call, about $0.17/1000 listings per the plan) — runaway protection only,
// same spirit as MOD_TEXT_DAILY_BUDGET/MOD_IMAGE_DAILY_BUDGET. Kept as its
// own `suggest` budget kind rather than sharing `mod_image`'s counter: an
// exhausted image-moderation budget leaves listings `pending` until midnight
// UTC (moderation/pipeline.ts), so a burst of autofill calls must never be
// able to spend the budget a real listing needs to finish moderating.
const DEFAULT_SUGGEST_DAILY_BUDGET = 1000;
// One giver's give flow calls this once per cover-photo change — 30/day/IP
// is loose on purpose (see budget.ts's per-IP-is-not-a-person note) and only
// exists to stop a single retry loop from working through the global ceiling
// alone.
const DEFAULT_SUGGEST_IP_DAILY_BUDGET = 30;

interface SuggestPhotoRow {
  id: string;
  owner_id: string;
  r2_key_thumb: string;
  content_type: string;
}

interface OrphanOrOwnedPhotoRow {
  id: string;
  owner_id: string;
  listing_id: string | null;
  r2_key_full: string;
  r2_key_thumb: string;
  listing_status: string | null;
}

photoRoutes.put(
  "/",
  ownerAuth({ createIfMissing: true }),
  burst("RL_UPLOAD"),
  dailyBudget({ kind: "upload", ipDailyLimitVar: "UPLOAD_IP_DAILY_BUDGET", fallbackIpDailyLimit: DEFAULT_UPLOAD_IP_DAILY_BUDGET }),
  async (c) => {
    const owner = c.get("owner");

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return fail(c, "bad_request", "Expected multipart/form-data with `full` and `thumb` files.", 400);
    }

    const full = form.get("full");
    const thumb = form.get("thumb");
    if (!(full instanceof File) || !(thumb instanceof File)) {
      return fail(c, "bad_request", "Both `full` and `thumb` files are required.", 400);
    }

    const fieldsResult = UploadPhotoFields.safeParse({
      width: Number(form.get("width")),
      height: Number(form.get("height")),
      blurhash: form.get("blurhash"),
    });
    if (!fieldsResult.success) {
      return fail(c, "bad_request", "Invalid photo metadata.", 400, {
        issues: fieldsResult.error.flatten() as unknown as Record<string, unknown>,
      });
    }
    const { width, height, blurhash } = fieldsResult.data;

    const maxBytes = parseIntVar("MAX_PHOTO_BYTES", c.env.MAX_PHOTO_BYTES, DEFAULT_MAX_PHOTO_BYTES);

    const fullBytes = new Uint8Array(await full.arrayBuffer());
    const thumbBytes = new Uint8Array(await thumb.arrayBuffer());

    if (fullBytes.byteLength > maxBytes || thumbBytes.byteLength > maxBytes) {
      return fail(c, "payload_too_large", "Photo exceeds the maximum upload size.", 413);
    }

    // Never trust the multipart part's declared content-type — sniff the
    // actual bytes. See docs/design/images.md.
    const fullType = sniffImageType(fullBytes);
    const thumbType = sniffImageType(thumbBytes);
    if (!fullType || !thumbType) {
      return fail(c, "unsupported_media", "Photos must be JPEG, PNG, or WebP.", 415);
    }

    const id = ulid();
    const fullKey = `photos/${id}/full.${extensionForSniffedType(fullType)}`;
    const thumbKey = `photos/${id}/thumb.${extensionForSniffedType(thumbType)}`;

    await c.env.BUCKET.put(fullKey, fullBytes, { httpMetadata: { contentType: fullType } });
    await c.env.BUCKET.put(thumbKey, thumbBytes, { httpMetadata: { contentType: thumbType } });

    const now = Date.now();
    await c.env.DB.prepare(
      `INSERT INTO photos
        (id, owner_id, listing_id, position, r2_key_full, r2_key_thumb, width, height, bytes_full, blurhash, content_type, moderation_status, created_at)
       VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 'unchecked', ?)`,
    )
      .bind(id, owner.id, fullKey, thumbKey, width, height, fullBytes.byteLength, blurhash, fullType, now)
      .run();

    return ok(
      c,
      {
        id,
        width,
        height,
        blurhash,
        url_full: `/i/${id}/full`,
        url_thumb: `/i/${id}/thumb`,
      },
      201,
    );
  },
);

photoRoutes.delete("/:id", ownerAuth(), async (c) => {
  const owner = c.get("owner");
  const id = requireParam(c, "id");

  const photo = await c.env.DB.prepare(
    `SELECT p.id, p.owner_id, p.listing_id, p.r2_key_full, p.r2_key_thumb, l.status AS listing_status
     FROM photos p LEFT JOIN listings l ON l.id = p.listing_id
     WHERE p.id = ?`,
  )
    .bind(id)
    .first<OrphanOrOwnedPhotoRow>();

  if (!photo || photo.owner_id !== owner.id) {
    return fail(c, "not_found", "Photo not found.", 404);
  }
  if (photo.listing_status === "given") {
    return fail(c, "conflict", "This keepsake has already been given — its photos can't be removed.", 409);
  }

  await c.env.BUCKET.delete(photo.r2_key_full);
  await c.env.BUCKET.delete(photo.r2_key_thumb);
  await c.env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(id).run();

  return ok(c, { id });
});

/**
 * AI autofill for the give flow. `ownerAuth()` proves *a* caller, not
 * ownership of *this* photo — checked below the same way `DELETE` does,
 * with the same 404 (never 403) for someone else's photo id, matching how
 * `routes/images.ts` never confirms a photo id exists to someone who can't
 * see it.
 *
 * Never 500s on a model failure: `suggestFromPhoto` doesn't throw, and a
 * failed suggestion is a non-event for the give flow — the giver just gets
 * an empty, already-usable form.
 */
photoRoutes.post("/:id/suggest", ownerAuth(), burst("RL_WRITE"), async (c) => {
  const owner = c.get("owner");
  const id = requireParam(c, "id");

  const photo = await c.env.DB.prepare("SELECT id, owner_id, r2_key_thumb, content_type FROM photos WHERE id = ?")
    .bind(id)
    .first<SuggestPhotoRow>();

  if (!photo || photo.owner_id !== owner.id) {
    return fail(c, "not_found", "Photo not found.", 404);
  }

  // Checked directly against `checkAndBump` (not the `dailyBudget`
  // middleware used for `listing`/`request`/`upload`) because this kind
  // needs a real global ceiling, not just a per-IP one — the same reason
  // `moderation/pipeline.ts` checks `mod_text`/`mod_image` inline rather
  // than through HTTP middleware.
  const dailyLimit = parseIntVar("SUGGEST_DAILY_BUDGET", c.env.SUGGEST_DAILY_BUDGET, DEFAULT_SUGGEST_DAILY_BUDGET);
  const ipDailyLimit = parseIntVar("SUGGEST_IP_DAILY_BUDGET", c.env.SUGGEST_IP_DAILY_BUDGET, DEFAULT_SUGGEST_IP_DAILY_BUDGET);
  const budget = await checkAndBump(c.env.KV, {
    kind: "suggest",
    clientIP: clientIPFrom(c.req.raw),
    dailyLimit,
    ipDailyLimit,
  });
  if (!budget.allowed) {
    return fail(c, "rate_limited", "Daily suggestion limit reached — please try again tomorrow.", 429, {
      ...(budget.retryAfter !== undefined ? { retryAfter: budget.retryAfter } : {}),
    });
  }

  const result = await suggestFromPhoto(c.env, photo);
  return ok(c, { suggestion: result.suggestion });
});

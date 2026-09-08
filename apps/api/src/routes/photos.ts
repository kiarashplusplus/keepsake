import { Hono } from "hono";
import type { Env } from "../env.js";
import { DEFAULT_SUGGEST_DAILY_BUDGET, parseIntVar } from "../env.js";
import { ok, fail } from "../lib/respond.js";
import { ulid } from "../lib/ids.js";
import { deletePhotoAndObjects, storePhotoUpload } from "../photos/store.js";
import { requireParam } from "../lib/params.js";
import { ownerAuth, type OwnerRow } from "../middleware/ownerAuth.js";
import { burst, dailyBudget } from "../middleware/rateLimit.js";
import { checkAndBump, clientIPFrom } from "../moderation/budget.js";
import { suggestFromPhoto } from "../suggest/suggest.js";

type Vars = { owner: OwnerRow };
export const photoRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

// The upload's byte ceilings, magic-byte sniff, dimension read and
// aspect-ratio refusal all moved to `src/photos/store.ts` when the estate
// bulk-upload route needed the same rules — their comments moved with them.
const DEFAULT_UPLOAD_IP_DAILY_BUDGET = 60;
// Global ceiling far past what a real day of givers reaches (~15 neurons per
// call, about $0.17/1000 listings per the plan) — runaway protection only,
// same spirit as MOD_TEXT_DAILY_BUDGET/MOD_IMAGE_DAILY_BUDGET. Kept as its
// own `suggest` budget kind rather than sharing `mod_image`'s counter: an
// exhausted image-moderation budget leaves listings `pending` until midnight
// UTC (moderation/pipeline.ts), so a burst of autofill calls must never be
// able to spend the budget a real listing needs to finish moderating.
// `DEFAULT_SUGGEST_DAILY_BUDGET` now lives in `../env.js` — three call sites
// share it (see that constant's comment).
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

// Launch audit finding 11: the burst limiter comes *before* `ownerAuth`, and
// the order is the point. `ownerAuth({ createIfMissing: true })` inserts an
// `owners` row for whatever random `ks_…` token the caller presented, and with
// it running first that insert had already happened by the time the request
// was 429'd or 400'd — unbounded, permanent junk in the table every owner
// lookup queries, at (combined with finding 10's measured limiter leakage) on
// the order of tens of thousands of rows a day from one address. Nothing swept
// them, and there is no delete-account path anywhere.
//
// Nothing between here and the handler needs the owner, so this costs nothing:
// `burst` keys on the caller's IP digest, not on identity. The daily KV budget
// stays behind `ownerAuth` — it is a write, and there is no reason to spend it
// before the token is even syntactically valid.
//
// ---------------------------------------------------------------------------
// There is deliberately no `turnstile()` here, and #183 is open about it.
//
// The obvious fix to #183 is to add `turnstile()` after `ownerAuth`, and the
// issue itself suggests it on the grounds that "the give flow already holds a
// Turnstile token at that point in the wizard". **It does not.** Checked
// 2026-09-07:
//
//   - `apps/web/app/give/index.tsx` is step 1 of 5 (photos) and uploads
//     immediately on pick, not at submit — `processFile` -> `uploadPhoto`.
//   - The only `<Turnstile>` widgets in the web app are on `give/review.tsx`
//     (step 5), `mine/email.tsx` and `recover/index.tsx`.
//   - `uploadPhoto` (`apps/web/src/api/photos.ts`) passes no `turnstileToken`,
//     so `apiFetch` sends no `cf-turnstile-response` header.
//
// `TURNSTILE_SECRET` *is* set on preview and production, where the middleware
// then enforces unconditionally — so mounting it here would 403 the first
// photo every real giver picks. A parallel session found the identical trap on
// `PATCH` (the web edit step mints no token either). Mounting this without
// changing the client is the more expensive mistake of the two available.
//
// Closing #183 needs a client change first, and a design decision with it: a
// Turnstile token is single-use and expires after 300s, while this step
// uploads up to 5 photos one at a time, so one widget on the photos step means
// either a challenge per photo, or a short-lived server-side upload grant
// (one challenge per give flow, exchanged for a token this route accepts N
// times). `apps/api/test/photoUploadTurnstile.test.ts` pins both halves so
// whoever mounts it here finds out that the client is still silent.
// ---------------------------------------------------------------------------
photoRoutes.put(
  "/",
  burst("RL_UPLOAD"),
  ownerAuth({ createIfMissing: true }),
  dailyBudget({ kind: "upload", ipDailyLimitVar: "UPLOAD_IP_DAILY_BUDGET", fallbackIpDailyLimit: DEFAULT_UPLOAD_IP_DAILY_BUDGET }),
  async (c) => {
    const owner = c.get("owner");

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return fail(c, "bad_request", "Expected multipart/form-data with `full` and `thumb` files.", 400);
    }

    // Every byte ceiling, the magic-byte sniff, the dimension read and the
    // aspect-ratio refusal now live in `src/photos/store.ts`, so the bulk
    // upload route cannot store a photo this route would have refused. This
    // handler is the adapter: parse the body, call the service, map a
    // refusal through this router's own `fail(...)`.
    const result = await storePhotoUpload(c.env, { ownerId: owner.id, form });
    if (!result.ok) {
      return fail(c, result.code, result.message, result.status, result.issues ? { issues: result.issues } : {});
    }

    return ok(c, result.photo, 201);
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

  await deletePhotoAndObjects(c.env, photo);

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

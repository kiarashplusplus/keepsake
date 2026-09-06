import { Hono } from "hono";
import * as Sentry from "@sentry/cloudflare";
import { CreateListingInput, UpdateListingInput } from "@keepsake/contracts/listing";
import type { Country } from "@keepsake/contracts/geo";
import { CreateReportInput } from "@keepsake/contracts/report";
import { CreateRequestInput, type CreateRequestResult } from "@keepsake/contracts/request";
import type { Env } from "../env.js";
import { ok, fail } from "../lib/respond.js";
import { ulid } from "../lib/ids.js";
import { requireParam } from "../lib/params.js";
import { ownerAuth, type OwnerRow } from "../middleware/ownerAuth.js";
import { idempotency } from "../middleware/idempotency.js";
import { turnstile } from "../middleware/turnstile.js";
import { burst, dailyBudget } from "../middleware/rateLimit.js";
import { validateBody } from "../middleware/validate.js";
import { lookupPostalCode } from "../geo/lookup.js";
import { sendMail } from "../email/sendMail.js";
import { verifyEmail } from "../email/templates/verifyEmail.js";
import { newRequest as newRequestTemplate } from "../email/templates/newRequest.js";
import { sha256Hex } from "../lib/digest.js";
import { todayISO } from "../lib/day.js";
import { randomTokenRaw } from "../lib/tokens.js";
import { clientIPFrom } from "../moderation/budget.js";
import { parseIntVar } from "../env.js";
import { moderateListing } from "../moderation/pipeline.js";
import { serializeOwnerListing, serializePublicListing } from "../lib/serialize.js";
import { fetchListingRow, fetchPhotoRows } from "../lib/listingsDb.js";

type Vars = { owner: OwnerRow; validatedBody: unknown };
export const listingRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

const DEFAULT_LISTING_IP_DAILY_BUDGET = 20;
const DEFAULT_REQUEST_IP_DAILY_BUDGET = 20;
const DEFAULT_REPORT_AUTOHIDE_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// POST /api/listings
// ---------------------------------------------------------------------------
// `burst("RL_CREATE")` first, for the reason spelled out on `PUT /api/photos`
// (launch audit finding 11): `ownerAuth({ createIfMissing: true })` mints an
// `owners` row on sight of any well-formed token, so it must not be the first
// thing a stranger's request reaches. Everything after it keeps its original
// order — `idempotency()` scopes its KV key by `owner.id` when an owner is
// present, and `turnstile()` stays in front of the daily budget so a failed
// challenge doesn't spend a real giver's 20-listings-a-day allowance.
listingRoutes.post(
  "/",
  burst("RL_CREATE"),
  ownerAuth({ createIfMissing: true }),
  idempotency(),
  turnstile(),
  dailyBudget({ kind: "listing", ipDailyLimitVar: "LISTING_IP_DAILY_BUDGET", fallbackIpDailyLimit: DEFAULT_LISTING_IP_DAILY_BUDGET }),
  validateBody(CreateListingInput),
  async (c) => {
    const owner = c.get("owner");
    const input = c.get("validatedBody") as import("@keepsake/contracts/listing").CreateListingInput;

    // Every photo_id must be this owner's own orphan upload — never someone
    // else's photo, and never one already attached to a listing.
    const placeholders = input.photo_ids.map(() => "?").join(",");
    const { results: ownedPhotos } = await c.env.DB.prepare(
      `SELECT id FROM photos WHERE owner_id = ? AND listing_id IS NULL AND id IN (${placeholders})`,
    )
      .bind(owner.id, ...input.photo_ids)
      .all<{ id: string }>();

    if (ownedPhotos.length !== input.photo_ids.length) {
      return fail(c, "bad_request", "One or more photos aren't available to attach.", 400);
    }

    const place = await lookupPostalCode(c.env, input.country, input.postal_code);
    if (!place) {
      return fail(c, "bad_request", "We don't know that postcode yet.", 400);
    }

    const id = ulid();
    const now = Date.now();

    await c.env.DB.prepare(
      `INSERT INTO listings
        (id, owner_id, title, story, category, country, postal_code, place_name, admin1, lat, lng,
         status, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)`,
    )
      .bind(
        id,
        owner.id,
        input.title,
        input.story,
        input.category,
        place.country,
        place.code,
        place.place_name,
        place.admin1,
        place.lat,
        place.lng,
        now,
        now,
      )
      .run();

    for (let position = 0; position < input.photo_ids.length; position++) {
      await c.env.DB.prepare("UPDATE photos SET listing_id = ?, position = ? WHERE id = ?")
        .bind(id, position, input.photo_ids[position])
        .run();
    }

    if (input.email) {
      await c.env.DB.prepare("UPDATE owners SET email = ?, email_verified_at = NULL WHERE id = ?")
        .bind(input.email, owner.id)
        .run();

      const rawVerifyToken = randomTokenRaw();
      const verifyTokenHash = await sha256Hex(rawVerifyToken);
      await c.env.DB.prepare(
        `INSERT INTO recovery_tokens (id, owner_id, purpose, token_hash, expires_at, created_at)
         VALUES (?, ?, 'verify_email', ?, ?, ?)`,
      )
        .bind(ulid(), owner.id, verifyTokenHash, now + 24 * 60 * 60 * 1000, now)
        .run();

      const verifyUrl = `${c.env.SITE_URL}/api/me/email/verify?token=${rawVerifyToken}`;
      await sendMail(c.env, { kind: "verify_email", to: input.email, ...verifyEmail({ link: verifyUrl }) });
    }

    c.executionCtx.waitUntil(moderateListing(c.env, id, 1));

    const row = await fetchListingRow(c.env, id);
    if (!row) return fail(c, "internal", "Listing failed to save.", 500);
    const photos = await fetchPhotoRows(c.env, id);
    return ok(c, serializeOwnerListing(row, photos), 201);
  },
);

// ---------------------------------------------------------------------------
// PATCH /api/listings/:id
// ---------------------------------------------------------------------------
listingRoutes.patch("/:id", ownerAuth(), validateBody(UpdateListingInput), async (c) => {
  const owner = c.get("owner");
  const id = requireParam(c, "id");
  const input = c.get("validatedBody") as import("@keepsake/contracts/listing").UpdateListingInput;

  const row = await fetchListingRow(c.env, id);
  if (!row || row.owner_id !== owner.id) {
    return fail(c, "not_found", "Listing not found.", 404);
  }
  if (row.status === "given") {
    return fail(c, "conflict", "This keepsake has already been given and can't be edited.", 409);
  }

  let place: { country: Country; code: string; place_name: string; admin1: string | null; lat: number; lng: number } | null = null;
  if (input.country && input.postal_code) {
    place = await lookupPostalCode(c.env, input.country, input.postal_code);
    if (!place) return fail(c, "bad_request", "We don't know that postcode yet.", 400);
  }

  if (input.photo_ids) {
    const placeholders = input.photo_ids.map(() => "?").join(",");
    const { results: ownedPhotos } = await c.env.DB.prepare(
      `SELECT id FROM photos WHERE owner_id = ? AND (listing_id IS NULL OR listing_id = ?) AND id IN (${placeholders})`,
    )
      .bind(owner.id, id, ...input.photo_ids)
      .all<{ id: string }>();
    if (ownedPhotos.length !== input.photo_ids.length) {
      return fail(c, "bad_request", "One or more photos aren't available to attach.", 400);
    }
  }

  const nextVersion = row.version + 1;
  const now = Date.now();

  await c.env.DB.prepare(
    `UPDATE listings SET
       title = ?, story = ?, category = ?,
       country = ?, postal_code = ?, place_name = ?, admin1 = ?, lat = ?, lng = ?,
       status = 'pending', moderation_reason = NULL, version = ?, updated_at = ?
     WHERE id = ? AND version = ?`,
  )
    .bind(
      input.title ?? row.title,
      input.story ?? row.story,
      input.category ?? row.category,
      place?.country ?? row.country,
      place?.code ?? row.postal_code,
      place?.place_name ?? row.place_name,
      place?.admin1 ?? row.admin1,
      place?.lat ?? row.lat,
      place?.lng ?? row.lng,
      nextVersion,
      now,
      id,
      row.version,
    )
    .run();

  if (input.photo_ids) {
    // Detach anything currently on this listing that isn't in the new set,
    // then (re)attach the new set in order.
    const placeholders = input.photo_ids.map(() => "?").join(",");
    await c.env.DB.prepare(`UPDATE photos SET listing_id = NULL, position = NULL WHERE listing_id = ? AND id NOT IN (${placeholders})`)
      .bind(id, ...input.photo_ids)
      .run();
    for (let position = 0; position < input.photo_ids.length; position++) {
      await c.env.DB.prepare("UPDATE photos SET listing_id = ?, position = ? WHERE id = ?")
        .bind(id, position, input.photo_ids[position])
        .run();
    }
  }

  c.executionCtx.waitUntil(moderateListing(c.env, id, nextVersion));

  const updatedRow = await fetchListingRow(c.env, id);
  if (!updatedRow) return fail(c, "internal", "Listing failed to save.", 500);
  const photos = await fetchPhotoRows(c.env, id);
  return ok(c, serializeOwnerListing(updatedRow, photos));
});

// ---------------------------------------------------------------------------
// DELETE /api/listings/:id
// ---------------------------------------------------------------------------
listingRoutes.delete("/:id", ownerAuth(), async (c) => {
  const owner = c.get("owner");
  const id = requireParam(c, "id");
  const row = await fetchListingRow(c.env, id);
  if (!row || row.owner_id !== owner.id) {
    return fail(c, "not_found", "Listing not found.", 404);
  }

  const { results: photos } = await c.env.DB.prepare("SELECT r2_key_full, r2_key_thumb FROM photos WHERE listing_id = ?")
    .bind(id)
    .all<{ r2_key_full: string; r2_key_thumb: string }>();
  for (const photo of photos) {
    await c.env.BUCKET.delete(photo.r2_key_full);
    await c.env.BUCKET.delete(photo.r2_key_thumb);
  }

  // `photos`, `requests`, `reports`, `moderation_events` all have
  // `ON DELETE CASCADE` back to `listings` (0001_init.sql) — this is the
  // only DB statement needed once R2 objects are gone.
  await c.env.DB.prepare("DELETE FROM listings WHERE id = ?").bind(id).run();

  return ok(c, { id });
});

// ---------------------------------------------------------------------------
// POST /api/listings/:id/given | withdraw | relist
// ---------------------------------------------------------------------------
listingRoutes.post("/:id/given", ownerAuth(), async (c) => {
  const owner = c.get("owner");
  const id = requireParam(c, "id");
  const row = await fetchListingRow(c.env, id);
  if (!row || row.owner_id !== owner.id) return fail(c, "not_found", "Listing not found.", 404);
  if (row.status !== "approved") {
    return fail(c, "conflict", "Only a live listing can be marked given.", 409);
  }

  const now = Date.now();
  await c.env.DB.prepare("UPDATE listings SET status = 'given', given_at = ?, updated_at = ? WHERE id = ? AND version = ?")
    .bind(now, now, id, row.version)
    .run();

  const updatedRow = await fetchListingRow(c.env, id);
  if (!updatedRow) return fail(c, "internal", "Listing failed to save.", 500);
  const photos = await fetchPhotoRows(c.env, id);
  return ok(c, serializeOwnerListing(updatedRow, photos));
});

listingRoutes.post("/:id/withdraw", ownerAuth(), async (c) => {
  const owner = c.get("owner");
  const id = requireParam(c, "id");
  const row = await fetchListingRow(c.env, id);
  if (!row || row.owner_id !== owner.id) return fail(c, "not_found", "Listing not found.", 404);
  if (row.status === "given" || row.status === "withdrawn") {
    return fail(c, "conflict", "This listing can't be withdrawn.", 409);
  }

  const now = Date.now();
  await c.env.DB.prepare("UPDATE listings SET status = 'withdrawn', updated_at = ? WHERE id = ? AND version = ?")
    .bind(now, id, row.version)
    .run();

  const updatedRow = await fetchListingRow(c.env, id);
  if (!updatedRow) return fail(c, "internal", "Listing failed to save.", 500);
  const photos = await fetchPhotoRows(c.env, id);
  return ok(c, serializeOwnerListing(updatedRow, photos));
});

listingRoutes.post("/:id/relist", ownerAuth(), async (c) => {
  const owner = c.get("owner");
  const id = requireParam(c, "id");
  const row = await fetchListingRow(c.env, id);
  if (!row || row.owner_id !== owner.id) return fail(c, "not_found", "Listing not found.", 404);
  if (row.status !== "withdrawn") {
    return fail(c, "conflict", "Only a withdrawn listing can be relisted.", 409);
  }

  const lastDecision = await c.env.DB.prepare(
    `SELECT verdict FROM moderation_events WHERE listing_id = ? AND listing_version = ? AND kind = 'decision' ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(id, row.version)
    .first<{ verdict: string }>();

  const now = Date.now();
  const nextStatus = lastDecision?.verdict === "approved" ? "approved" : "pending";
  await c.env.DB.prepare("UPDATE listings SET status = ?, moderation_reason = NULL, updated_at = ? WHERE id = ? AND version = ?")
    .bind(nextStatus, now, id, row.version)
    .run();

  if (nextStatus === "pending") {
    c.executionCtx.waitUntil(moderateListing(c.env, id, row.version));
  }

  const updatedRow = await fetchListingRow(c.env, id);
  if (!updatedRow) return fail(c, "internal", "Listing failed to save.", 500);
  const photos = await fetchPhotoRows(c.env, id);
  return ok(c, serializeOwnerListing(updatedRow, photos));
});

// ---------------------------------------------------------------------------
// GET /api/listings/:id — public, approved/given only
// ---------------------------------------------------------------------------
listingRoutes.get("/:id", burst("RL_READ"), async (c) => {
  const id = requireParam(c, "id");
  const row = await fetchListingRow(c.env, id);
  if (!row || (row.status !== "approved" && row.status !== "given")) {
    return fail(c, "not_found", "Listing not found.", 404);
  }
  const photos = await fetchPhotoRows(c.env, id);
  return ok(c, serializePublicListing(row, photos));
});

// ---------------------------------------------------------------------------
// POST /api/listings/:id/reports
// ---------------------------------------------------------------------------
listingRoutes.post(
  "/:id/reports",
  turnstile(),
  burst("RL_REPORT"),
  validateBody(CreateReportInput),
  async (c) => {
    const id = requireParam(c, "id");
    const input = c.get("validatedBody") as CreateReportInput;

    const row = await fetchListingRow(c.env, id);
    if (!row || (row.status !== "approved" && row.status !== "given")) {
      return fail(c, "not_found", "Listing not found.", 404);
    }

    // Rotates daily (sha256(day:ip), the same shape src/moderation/budget.ts
    // uses for its KV keys) — the same address can report the same listing
    // again tomorrow; this only blocks a repeat within one day, on purpose,
    // so `reports.ip_digest` never becomes a long-term per-address
    // identifier.
    const ipDigest = await sha256Hex(`${todayISO()}:${clientIPFrom(c.req.raw)}`);

    const existing = await c.env.DB.prepare("SELECT id FROM reports WHERE listing_id = ? AND ip_digest = ?")
      .bind(id, ipDigest)
      .first<{ id: string }>();
    if (existing) {
      return fail(c, "conflict", "You've already reported this one.", 409);
    }

    const now = Date.now();
    const reportId = ulid();
    await c.env.DB.prepare(
      `INSERT INTO reports (id, listing_id, reason, details, ip_digest, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(reportId, id, input.reason, input.details ?? null, ipDigest, now)
      .run();
    await c.env.DB.prepare("UPDATE listings SET report_count = report_count + 1 WHERE id = ?").bind(id).run();

    const reportCount = row.report_count + 1;
    const threshold = parseIntVar("REPORT_AUTOHIDE_THRESHOLD", c.env.REPORT_AUTOHIDE_THRESHOLD, DEFAULT_REPORT_AUTOHIDE_THRESHOLD);

    // Only pulls a listing that's currently public — a report against a
    // listing already `given`/`hidden`/etc. still counts (report_count
    // above already incremented) but never flips status out from under a
    // state this middleware didn't put it in.
    if (reportCount >= threshold && row.status === "approved") {
      await c.env.DB.prepare("UPDATE listings SET status = 'hidden', updated_at = ? WHERE id = ? AND status = 'approved'")
        .bind(now, id)
        .run();
      await c.env.DB.prepare(
        `INSERT INTO moderation_events (id, listing_id, listing_version, kind, verdict, reason, attempt, created_at)
         VALUES (?, ?, ?, 'report_autohide', 'hidden', 'report_autohide', 1, ?)`,
      )
        .bind(ulid(), id, row.version, now)
        .run();

      // A listing dropping out of the public feed on its own, with no admin
      // action, is exactly the kind of thing Kiarash should hear about
      // without having to remember to check the queue — the listing id is a
      // public ULID (already in every share link), not PII, so it's safe to
      // put in the message itself.
      Sentry.captureMessage(`Listing ${id} auto-hidden after ${reportCount} reports`, "warning");
    }

    return ok(c, { id: reportId }, 201);
  },
);

// ---------------------------------------------------------------------------
// POST /api/listings/:id/requests
// ---------------------------------------------------------------------------
listingRoutes.post(
  "/:id/requests",
  idempotency(),
  turnstile(),
  burst("RL_REQUEST"),
  dailyBudget({ kind: "request", ipDailyLimitVar: "REQUEST_IP_DAILY_BUDGET", fallbackIpDailyLimit: DEFAULT_REQUEST_IP_DAILY_BUDGET }),
  validateBody(CreateRequestInput),
  async (c) => {
    const id = requireParam(c, "id");
    const input = c.get("validatedBody") as CreateRequestInput;

    const row = await fetchListingRow(c.env, id);
    if (!row || row.status !== "approved") {
      return fail(c, "not_found", "Listing not found.", 404);
    }

    const owner = await c.env.DB.prepare("SELECT email, email_verified_at, banned_at FROM owners WHERE id = ?")
      .bind(row.owner_id)
      .first<{ email: string | null; email_verified_at: number | null; banned_at: number | null }>();

    // A banned owner's listings are meant to already be hidden (the admin
    // ban action hides every non-given one), but this is the same
    // "not found, not forbidden" treatment `ownerAuth` gives a banned
    // owner's own requests — a stranger asking about a listing gets no
    // signal that a ban is the reason it's unavailable.
    if (owner?.banned_at !== null && owner?.banned_at !== undefined) {
      return fail(c, "not_found", "Listing not found.", 404);
    }

    // The giver asking for their own keepsake isn't a request anyone can
    // "choose" — there's no one else to hand it to — and it would otherwise
    // sit in the queue looking like a real ask.
    if (owner?.email && owner.email.toLowerCase() === input.email.toLowerCase()) {
      return fail(c, "bad_request", "That's your own keepsake.", 400);
    }

    // Pre-check rather than relying on the UNIQUE(listing_id, email)
    // constraint to reject a duplicate — same style as the reports handler
    // above and `ownerAuth`'s ON CONFLICT DO NOTHING: an honest, readable
    // 409 rather than parsing a D1 driver error message.
    const existingRequest = await c.env.DB.prepare("SELECT id FROM requests WHERE listing_id = ? AND email = ?")
      .bind(id, input.email)
      .first<{ id: string }>();
    if (existingRequest) {
      return fail(c, "conflict", "You've already asked for this one.", 409);
    }

    const clientIp = clientIPFrom(c.req.raw);
    const ipDigest = await sha256Hex(`${todayISO()}:${clientIp}`);
    const now = Date.now();
    const requestId = ulid();

    await c.env.DB.prepare(
      `INSERT INTO requests (id, listing_id, note, email, phone, ip_digest, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
    )
      .bind(requestId, id, input.note, input.email, input.phone ?? null, ipDigest, now)
      .run();
    await c.env.DB.prepare("UPDATE listings SET request_count = request_count + 1 WHERE id = ?").bind(id).run();

    if (owner?.email && owner.email_verified_at !== null) {
      const dashboardLink = `${c.env.SITE_URL}/mine/${id}`;
      const template = newRequestTemplate({ listingTitle: row.title, note: input.note, dashboardLink });
      const result = await sendMail(c.env, { kind: "new_request", to: owner.email, ...template });
      if (result.sent) {
        await c.env.DB.prepare("UPDATE requests SET notified_at = ? WHERE id = ?").bind(Date.now(), requestId).run();
      }
    }

    const result: CreateRequestResult = { id: requestId, created_at: now };
    return ok(c, result, 201);
  },
);

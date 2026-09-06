import { Hono } from "hono";
import { CreateListingInput, UpdateListingInput } from "@keepsake/contracts/listing";
import type { Country } from "@keepsake/contracts/geo";
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
import { sha256Hex } from "../lib/digest.js";
import { moderateListing } from "../moderation/pipeline.js";
import { serializeOwnerListing, serializePublicListing } from "../lib/serialize.js";
import { fetchListingRow, fetchPhotoRows } from "../lib/listingsDb.js";

type Vars = { owner: OwnerRow; validatedBody: unknown };
export const listingRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

const DEFAULT_LISTING_IP_DAILY_BUDGET = 20;

// ---------------------------------------------------------------------------
// POST /api/listings
// ---------------------------------------------------------------------------
listingRoutes.post(
  "/",
  ownerAuth({ createIfMissing: true }),
  idempotency(),
  turnstile(),
  burst("RL_CREATE"),
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

      const rawVerifyToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
      const verifyTokenHash = await sha256Hex(rawVerifyToken);
      await c.env.DB.prepare(
        `INSERT INTO recovery_tokens (id, owner_id, purpose, token_hash, expires_at, created_at)
         VALUES (?, ?, 'verify_email', ?, ?, ?)`,
      )
        .bind(ulid(), owner.id, verifyTokenHash, now + 24 * 60 * 60 * 1000, now)
        .run();

      // The verify endpoint itself (`GET /api/me/email/verify`) is M3 scope —
      // this link is a placeholder until then. Sending it anyway (via the
      // `sendMail` stub in dev/preview) is still useful: it proves the plumbing
      // end to end and gives Kiarash a real preview of the email shape early.
      const verifyUrl = `${c.env.SITE_URL}/api/me/email/verify?token=${rawVerifyToken}`;
      await sendMail(c.env, {
        to: input.email,
        subject: "Confirm your email — Keepsake",
        html: `<p>Confirm your email to get notified about your keepsake and recover your listings later.</p><p><a href="${verifyUrl}">Confirm email</a></p>`,
        text: `Confirm your email: ${verifyUrl}`,
      });
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
listingRoutes.get("/:id", async (c) => {
  const id = requireParam(c, "id");
  const row = await fetchListingRow(c.env, id);
  if (!row || (row.status !== "approved" && row.status !== "given")) {
    return fail(c, "not_found", "Listing not found.", 404);
  }
  const photos = await fetchPhotoRows(c.env, id);
  return ok(c, serializePublicListing(row, photos));
});

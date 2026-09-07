import { Hono } from "hono";
import { captureMessage } from "@keepsake/observability/capture";
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
import { requestReceived as requestReceivedTemplate } from "../email/templates/requestReceived.js";
import { dailyIpDigest, sha256Hex } from "../lib/digest.js";
import { randomTokenRaw } from "../lib/tokens.js";
import { clientIPFrom } from "../moderation/budget.js";
import { reportAutohideThreshold } from "../env.js";
import { moderateListing } from "../moderation/pipeline.js";
import { purgePhotoCache } from "../lib/photoCache.js";
import { containsContactInfo } from "../moderation/contactInfo.js";
import { serializeOwnerListing, serializePublicListing } from "../lib/serialize.js";
import { fetchAspectRows, fetchListingRow, fetchPhotoRows, replaceListingAspects } from "../lib/listingsDb.js";
import { reembedListing } from "../search/reembed.js";
import { deleteListingVector } from "../search/vectorize.js";

type Vars = { owner: OwnerRow; validatedBody: unknown };
export const listingRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

const DEFAULT_LISTING_IP_DAILY_BUDGET = 20;
const DEFAULT_REQUEST_IP_DAILY_BUDGET = 20;
/** Issue #92. Ten distinct listings reported from one address in one day is
 * already far more than a person browsing their own area could plausibly
 * find wrong; a script walking the catalogue passes it in seconds. Loose for
 * the same reason as every other per-IP number here (an address is not a
 * person — see `moderation/budget.ts`'s header on CGNAT), but unlike the
 * burst brake it is a real ceiling. */
const DEFAULT_REPORT_IP_DAILY_BUDGET = 10;

/**
 * Issue #171. Aspects arrived as model output (#36) and were treated as
 * trusted ever since, but `CreateListingInput`/`UpdateListingInput` accept
 * them straight from the client like any other field — nothing requires a
 * value to have come from the suggestion call. They were then published
 * verbatim on `PublicListing.aspects`, grouped into browse shelves and
 * folded into the embedding text, having passed neither the contact-info
 * gate nor Llama Guard (both of which read only `title`/`story`). The
 * measured consequence: the *same* email address auto-rejects in the story
 * as `contact_in_story` and sails through as an aspect value.
 *
 * 48 characters of `value` is ample for an email, a phone number or a short
 * URL, and `name` is a second uncontrolled 24-character string — so both
 * halves are checked, not just the value.
 *
 * Returned as a 400 before anything is written, exactly the way the request
 * note at `POST /api/listings/:id/requests` already handles the identical
 * problem. `moderation/pipeline.ts` re-checks the persisted aspects too, so
 * a row that reached the DB some other way (a backfill, an older client)
 * is still caught — this boundary check is the one that gives the giver a
 * useful error, not the only thing standing in the way.
 */
function aspectsContainContactInfo(aspects: readonly { name: string; value: string }[] | undefined): boolean {
  if (!aspects) return false;
  return aspects.some((aspect) => containsContactInfo(aspect.name) || containsContactInfo(aspect.value));
}

const ASPECT_CONTACT_INFO_MESSAGE =
  "Keep contact details out of the item details — people reach you through Keepsake.";

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

    // Issue #171 — before any write, and before the photo/postcode lookups,
    // for the same reason the request-note check sits above its insert.
    if (aspectsContainContactInfo(input.aspects)) {
      return fail(c, "bad_request", ASPECT_CONTACT_INFO_MESSAGE, 400);
    }

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
         status, version, created_at, updated_at, age_attested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?)`,
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
        // Issue #64: `CreateListingInput.date_of_birth` is validated by
        // `DateOfBirthSchema` — a request only reaches this handler at all
        // once it's already confirmed the birth date implies `MINIMUM_AGE`
        // or older, so its mere presence here means the gate passed. Same
        // "record the moment, not just the fact" convention as
        // `email_verified_at`/`chosen_at` elsewhere in this schema — and
        // the date of birth itself is deliberately never bound into this
        // query or stored anywhere; only this timestamp is.
        input.date_of_birth ? now : null,
      )
      .run();

    for (let position = 0; position < input.photo_ids.length; position++) {
      await c.env.DB.prepare("UPDATE photos SET listing_id = ?, position = ? WHERE id = ?")
        .bind(id, position, input.photo_ids[position])
        .run();
    }

    // `input.aspects` defaults to `[]` (CreateListingInput), never
    // undefined, so this always runs — a brand-new listing with no
    // confidently-read aspects gets zero rows, not a skipped write.
    await replaceListingAspects(c.env, id, input.aspects);

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

    c.executionCtx.waitUntil(moderateListing(c.env, id, 1, clientIPFrom(c.req.raw)));
    // Issue #38: indexed for semantic search regardless of moderation
    // outcome, the same way `listings_fts`'s insert trigger indexes every
    // new row regardless of status — a listing not yet approved still
    // needs to be ready to search the moment it is.
    c.executionCtx.waitUntil(reembedListing(c.env, id));

    const row = await fetchListingRow(c.env, id);
    if (!row) return fail(c, "internal", "Listing failed to save.", 500);
    const photos = await fetchPhotoRows(c.env, id);
    const aspects = await fetchAspectRows(c.env, id);
    return ok(c, serializeOwnerListing(row, photos, aspects), 201);
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

  // Issue #171 — same gate as create. An edit is the other way client-supplied
  // aspect text reaches `listing_aspects` and `PublicListing.aspects`.
  if (aspectsContainContactInfo(input.aspects)) {
    return fail(c, "bad_request", ASPECT_CONTACT_INFO_MESSAGE, 400);
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

  // `UpdateListingInput.aspects` is a plain `.optional()` override, not the
  // usual `.partial()` treatment (see the contract's own comment on why) —
  // an `aspects` key genuinely absent from the request body parses to
  // `undefined` here, distinct from an explicit `[]`, which is truthy
  // (arrays always are) and does replace. Only overwrite when the client
  // actually sent something, the same rule `input.photo_ids` above already
  // follows: a re-submit that never touched aspects must not silently wipe
  // them.
  if (input.aspects) {
    await replaceListingAspects(c.env, id, input.aspects);
  }

  c.executionCtx.waitUntil(moderateListing(c.env, id, nextVersion, clientIPFrom(c.req.raw)));
  // Issue #38: re-embed whenever the request could have changed what's
  // actually searchable — title, story, or aspects. `input.title`/
  // `input.story` are `UpdateListingInput`'s normal `.partial()` optionals
  // (absent means "unchanged", same convention `place`/`photo_ids` above
  // already follow); `input.aspects` uses the non-defaulting override
  // `replaceListingAspects`'s own doc comment explains. Skipping this for a
  // photo-only or location-only edit isn't just an optimization — it also
  // means a listing that's exhausted EMBED_DAILY_BUDGET for the day doesn't
  // get charged again for an edit that couldn't have changed its vector.
  if (input.title !== undefined || input.story !== undefined || input.aspects !== undefined) {
    c.executionCtx.waitUntil(reembedListing(c.env, id));
  }

  const updatedRow = await fetchListingRow(c.env, id);
  if (!updatedRow) return fail(c, "internal", "Listing failed to save.", 500);
  const photos = await fetchPhotoRows(c.env, id);
  const aspects = await fetchAspectRows(c.env, id);
  return ok(c, serializeOwnerListing(updatedRow, photos, aspects));
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

  const { results: photos } = await c.env.DB.prepare("SELECT id, r2_key_full, r2_key_thumb FROM photos WHERE listing_id = ?")
    .bind(id)
    .all<{ id: string; r2_key_full: string; r2_key_thumb: string }>();
  for (const photo of photos) {
    await c.env.BUCKET.delete(photo.r2_key_full);
    await c.env.BUCKET.delete(photo.r2_key_thumb);
    // Issue #22: the R2 bytes are gone; also drop any cached edge copy so
    // nothing can keep serving them from `caches.default`. See
    // `lib/photoCache.ts` for why this is defense in depth rather than the
    // whole fix — `GET /i/:id/:variant` already re-checks the DB before
    // ever consulting the cache, so this route alone can't serve a deleted
    // photo either way.
    c.executionCtx.waitUntil(purgePhotoCache(c.env, photo.id));
  }

  // `photos`, `requests`, `reports`, `moderation_events` and
  // `listing_aspects` all have `ON DELETE CASCADE` back to `listings`
  // (0001_init.sql, rebuilt for `requests` in 0005, added for
  // `listing_aspects` in 0006), and `listings_fts` is swept by a trigger
  // (0003) — so this is the only DB statement needed once R2 objects are
  // gone.
  //
  // Issue #90: that used to be this comment's word against nothing. SQLite
  // does not enforce foreign keys unless `PRAGMA foreign_keys` is on, and
  // nothing in this repo sets it — D1 defaults it on, which is external
  // knowledge this route silently depends on. `test/cascadeDelete.test.ts`
  // now seeds all five child tables, deletes through this handler, and
  // asserts by querying that every child row is gone; it also enumerates
  // the schema's foreign keys so a child table added later without a
  // cascade fails rather than quietly orphaning a requester's note, email
  // and phone with no listing left to reach them through.
  //
  // The Vectorize row has no such mechanism — D1 cascades don't reach an
  // external index — so it's deleted explicitly below. Today that is
  // belt-and-braces rather than load-bearing (`fetchCandidateRows` joins
  // back to `listings` on `status = 'approved'`, and a deleted row simply
  // isn't there to match), but there's no reason to leave a dead vector in
  // the index once the listing it represents is gone.
  await c.env.DB.prepare("DELETE FROM listings WHERE id = ?").bind(id).run();
  c.executionCtx.waitUntil(deleteListingVector(c.env, id));

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
  const aspects = await fetchAspectRows(c.env, id);
  return ok(c, serializeOwnerListing(updatedRow, photos, aspects));
});

// Withdraw deliberately still accepts a `rejected`, `hidden` or
// `needs_review` listing (issue #162 asked the question explicitly): an owner
// who wants a taken-down listing gone entirely is doing something legitimate,
// and refusing here would only teach them to delete it instead. The one-way
// door is `relist` below, not this guard.
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
  const aspects = await fetchAspectRows(c.env, id);
  return ok(c, serializeOwnerListing(updatedRow, photos, aspects));
});

listingRoutes.post("/:id/relist", ownerAuth(), async (c) => {
  const owner = c.get("owner");
  const id = requireParam(c, "id");
  const row = await fetchListingRow(c.env, id);
  if (!row || row.owner_id !== owner.id) return fail(c, "not_found", "Listing not found.", 404);
  if (row.status !== "withdrawn") {
    return fail(c, "conflict", "Only a withdrawn listing can be relisted.", 409);
  }

  // Issue #162. This used to read `kind = 'decision'` only, which meant it
  // could not see any of the four takedowns this product actually has —
  // `POST /api/admin/listings/:id/reject`, `.../hide`, the ban sweep (all
  // three `kind = 'admin'`, see admin.ts's `logAdminEvent`) and the
  // three-report auto-hide (`kind = 'report_autohide'`, below). None of them
  // bumps `version`, so the newest `decision` row was still the pipeline's
  // original `approved` and an owner could undo any of them with
  // `withdraw` + `relist` — two calls authenticated by nothing but the
  // device token they already had. Indefinitely, with no cooldown, and the
  // relisted row dropped out of the admin queue's `report_pressure` view on
  // the way past.
  //
  // So: the newest *status-setting* event of any kind, not the newest
  // `decision`. `text`/`image` events are excluded because they are
  // per-model sub-results, not decisions, and `admin`/`request_removed`
  // (issue #70) is excluded because it is an event about one request inside
  // the listing and says nothing about the listing's own status.
  //
  // `created_at DESC, rowid DESC`: ULIDs are only monotonic across
  // milliseconds, so two events written in the same millisecond order
  // randomly by `id`. `rowid` is insertion order, which is the thing we
  // actually mean, and `moderation_events` is an ordinary rowid table
  // (0001_init.sql — no `WITHOUT ROWID`).
  const lastStatusEvent = await c.env.DB.prepare(
    `SELECT kind, verdict, reason FROM moderation_events
     WHERE listing_id = ? AND listing_version = ?
       AND (kind = 'decision'
            OR kind = 'report_autohide'
            OR (kind = 'admin' AND verdict IN ('approved', 'restored', 'hidden', 'rejected')))
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  )
    .bind(id, row.version)
    .first<{ kind: string; verdict: string; reason: string | null }>();

  // A takedown is never relistable straight back to `approved`, and — the
  // part that is easy to get wrong — it must not go to `pending` either.
  // `pending` re-runs the AI pipeline, which is precisely the judgement a
  // human overrode when they rejected or hid the listing, so the pipeline
  // would cheerfully re-approve it seconds later and the bypass would be
  // exactly as complete, just slower. `needs_review` puts it back in front
  // of a person instead, and `held_for_review` is the honest reason the
  // owner sees (`MODERATION_REASONS` in @keepsake/contracts/listing).
  const wasTakenDown =
    lastStatusEvent !== null &&
    (lastStatusEvent.kind === "report_autohide" ||
      (lastStatusEvent.kind === "admin" && (lastStatusEvent.verdict === "hidden" || lastStatusEvent.verdict === "rejected")));

  // `restored` is an admin explicitly putting a hidden listing back — it is
  // as much an approval as the pipeline's own.
  const wasApproved =
    !wasTakenDown &&
    ((lastStatusEvent?.kind === "decision" && lastStatusEvent.verdict === "approved") ||
      (lastStatusEvent?.kind === "admin" && (lastStatusEvent.verdict === "approved" || lastStatusEvent.verdict === "restored")));

  const now = Date.now();
  const nextStatus = wasTakenDown ? "needs_review" : wasApproved ? "approved" : "pending";
  const nextReason = wasTakenDown ? "held_for_review" : null;
  await c.env.DB.prepare("UPDATE listings SET status = ?, moderation_reason = ?, updated_at = ? WHERE id = ? AND version = ?")
    .bind(nextStatus, nextReason, now, id, row.version)
    .run();

  if (nextStatus === "pending") {
    c.executionCtx.waitUntil(moderateListing(c.env, id, row.version, clientIPFrom(c.req.raw)));
  }

  const updatedRow = await fetchListingRow(c.env, id);
  if (!updatedRow) return fail(c, "internal", "Listing failed to save.", 500);
  const photos = await fetchPhotoRows(c.env, id);
  const aspects = await fetchAspectRows(c.env, id);
  return ok(c, serializeOwnerListing(updatedRow, photos, aspects));
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
  const aspects = await fetchAspectRows(c.env, id);
  return ok(c, serializePublicListing(row, photos, aspects));
});

// ---------------------------------------------------------------------------
// POST /api/listings/:id/reports
// ---------------------------------------------------------------------------
// Issue #92: `burst("RL_REPORT")` used to be the only limiter on the one
// endpoint that can pull a listing out of public view (three reports and
// `REPORT_AUTOHIDE_THRESHOLD` hides it). `burst()` is best-effort by
// Cloudflare's own documentation and was measured leaking ~2.6x its limit
// (#8), and the `ip_digest` uniqueness check below only stops one address
// reporting the *same* listing twice a day — it never stopped one address
// reporting fifty *different* listings, each toward its own auto-hide. So
// this route now carries the same hard KV ceiling `listing`/`request`/
// `upload` do. `turnstile()` stays in front of it, so a failed challenge
// doesn't spend a real reporter's allowance.
//
// What it does not do, said plainly rather than left to be discovered: the
// ceiling is per address, so a caller with a range of them — a residential
// IPv6 /64 is 2^64 addresses — gets a fresh ceiling with each one. That is
// true of every per-IP number in this Worker (`moderation/budget.ts`'s
// header says so about all of them) and the alternatives both cost more
// than they're worth today: keying on a prefix refuses whole households and
// CGNAT ranges at once, and per-install limiting needs a client credential
// that doesn't exist. This raises the cost of walking the catalogue from
// free to needing addresses. It does not end it.
listingRoutes.post(
  "/:id/reports",
  turnstile(),
  burst("RL_REPORT"),
  dailyBudget({ kind: "report", ipDailyLimitVar: "REPORT_IP_DAILY_BUDGET", fallbackIpDailyLimit: DEFAULT_REPORT_IP_DAILY_BUDGET }),
  validateBody(CreateReportInput),
  async (c) => {
    const id = requireParam(c, "id");
    const input = c.get("validatedBody") as CreateReportInput;

    const row = await fetchListingRow(c.env, id);
    if (!row || (row.status !== "approved" && row.status !== "given")) {
      return fail(c, "not_found", "Listing not found.", 404);
    }

    // Rotates daily (sha256(day:ip), the one shape `lib/digest.ts` allows
    // an address to be hashed into) — the same address can report the same
    // listing again tomorrow; this only blocks a repeat within one day, on
    // purpose, so `reports.ip_digest` never becomes a long-term per-address
    // identifier.
    const ipDigest = await dailyIpDigest(clientIPFrom(c.req.raw));

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
    // Issue #184: `RETURNING`, not a second read and not `row.report_count + 1`.
    // The increment was always atomic; the *decision* was not. `row` is
    // fetched at the top of this handler, before the `reports` insert and
    // before this update, so three people reporting the same listing in the
    // same second — which is exactly how reports on genuinely bad content
    // arrive, because they arrive when the content is being seen — all read
    // `report_count = 0`, all computed `1`, and `1 >= 3` was false for every
    // one of them. The stored count was 3 and the listing stayed public
    // until a fourth, non-concurrent report showed up. A listing at a true
    // count of 5 could still be evaluated as 1. The `report_autohide` event
    // and the warning were skipped along with the hide, so nothing recorded
    // that the threshold had been crossed and the admin queue's
    // report-pressure view had nothing to join against either.
    //
    // `RETURNING` closes the window entirely and keeps it to one round trip:
    // the count and status this branch reads are the post-increment ones,
    // read inside the same statement that wrote them, so exactly one of N
    // concurrent reporters sees the value that crosses the threshold.
    const incremented = await c.env.DB.prepare(
      "UPDATE listings SET report_count = report_count + 1 WHERE id = ? RETURNING report_count, status",
    )
      .bind(id)
      .first<{ report_count: number; status: string }>();

    const reportCount = incremented?.report_count ?? row.report_count + 1;
    const statusAfterIncrement = incremented?.status ?? row.status;
    const threshold = reportAutohideThreshold(c.env);

    // Only pulls a listing that's currently public — a report against a
    // listing already `given`/`hidden`/etc. still counts (report_count
    // above already incremented) but never flips status out from under a
    // state this middleware didn't put it in. Reading the status off the
    // same `RETURNING` row is what stops a later concurrent reporter
    // re-hiding (and re-eventing) a listing an earlier one already hid.
    if (reportCount >= threshold && statusAfterIncrement === "approved") {
      // `AND status = 'approved'` was already here; `RETURNING id` is what
      // makes it usable as a compare-and-set. With five overlapping reports,
      // two callers can both read `approved` off their own increment (the
      // third one's hide has not committed yet) and both enter this branch —
      // measured, two `report_autohide` events for one hide. Only the caller
      // whose UPDATE actually changed a row writes the event and the warning,
      // so the record of the hide is exactly one row however many reporters
      // arrive at once.
      const hidden = await c.env.DB.prepare(
        "UPDATE listings SET status = 'hidden', updated_at = ? WHERE id = ? AND status = 'approved' RETURNING id",
      )
        .bind(now, id)
        .first<{ id: string }>();
      if (!hidden) return ok(c, { id: reportId }, 201);

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
      //
      // Issue #89: this line goes to Workers Logs and nothing reads Workers
      // Logs on a schedule (no Tail Worker, no Logpush — see
      // docs/runbooks/incident.md), so on its own it never reached a human.
      // It is kept, and tagged, because it is still the only record of the
      // *moment* the hide happened that survives a later admin action: the
      // durable, actually-polled signal is now
      // `GET /api/admin/health`'s `report_pressure` (src/routes/admin.ts)
      // and the hourly `.github/workflows/report-pressure.yml` that reads
      // the same rows out of D1. `tags.source` makes this filterable in the
      // Workers Logs UI (`tags.source = "report_autohide"`) instead of
      // needing a substring match on the message.
      captureMessage(`Listing ${id} auto-hidden after ${reportCount} reports`, "warning", {
        tags: { source: "report_autohide" },
        extra: { listing_id: id, report_count: reportCount, threshold },
      });
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
    // "given" gets its own honest code — the listing existed and was live,
    // it's just spoken for now. Every other non-approved status (pending,
    // rejected, withdrawn, needs_review, hidden, or missing entirely) keeps
    // the plain 404: see the banned-owner check below for why "not found,
    // not forbidden" is deliberate there too.
    if (row?.status === "given") {
      return fail(c, "gone", "This keepsake was just given to someone else.", 410);
    }
    if (!row || row.status !== "approved") {
      return fail(c, "not_found", "Listing not found.", 404);
    }

    // A note's own free text is never moderated by the AI gates (that budget
    // is reserved for the title/story on listing create/edit) — this is the
    // same local regex check as `moderation/pipeline.ts`'s contact-in-story
    // guard, applied here so an unmoderated note never lands in the
    // `requests` table or gets emailed verbatim to the giver.
    if (containsContactInfo(input.note)) {
      return fail(
        c,
        "bad_request",
        "Please leave contact details out of your note — we'll share them once the giver chooses you.",
        400,
      );
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
    const ipDigest = await dailyIpDigest(clientIp);
    const now = Date.now();
    const requestId = ulid();

    // A random, single-use secret this requester can later present, with no
    // account, to withdraw this exact request and erase its own PII — see
    // src/routes/requestWithdraw.ts. Only the hash is stored, same as every
    // other bearer secret this Worker mints (src/lib/tokens.ts).
    const rawWithdrawToken = randomTokenRaw();
    const withdrawTokenHash = await sha256Hex(rawWithdrawToken);

    await c.env.DB.prepare(
      `INSERT INTO requests (id, listing_id, note, email, phone, ip_digest, status, created_at, age_attested_at, withdraw_token_hash)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    )
      .bind(
        requestId,
        id,
        input.note,
        input.email,
        input.phone ?? null,
        ipDigest,
        now,
        // Same convention as the listing insert above: `input.date_of_birth`
        // is only reachable here already validated against `MINIMUM_AGE`,
        // and is never itself bound into this query.
        input.date_of_birth ? now : null,
        withdrawTokenHash,
      )
      .run();
    await c.env.DB.prepare("UPDATE listings SET request_count = request_count + 1 WHERE id = ?").bind(id).run();

    if (owner?.email && owner.email_verified_at !== null) {
      const dashboardLink = `${c.env.SITE_URL}/mine/${id}`;
      const template = newRequestTemplate({ listingTitle: row.title, note: input.note, dashboardLink });
      const result = await sendMail(c.env, { kind: "new_request", to: owner.email, ...template });
      if (result.sent) {
        await c.env.DB.prepare("UPDATE requests SET notified_at = ? WHERE id = ?").bind(Date.now(), requestId).run();
      } else {
        // Issue #6: this used to be silently discarded — the giver's own
        // email address rejected the notification and nothing said so
        // anywhere they could see it. Recorded on the request itself (not
        // just `email_events`) so the owner dashboard can surface it right
        // next to the ask it belongs to.
        await c.env.DB.prepare("UPDATE requests SET notify_failed_reason = ? WHERE id = ?")
          .bind(result.reason ?? "send_failed", requestId)
          .run();
      }
    }

    // Always sent — a requester never gets a dashboard or a device token, so
    // this confirmation (and the withdraw link inside it) is the only record
    // they get of having asked, and the only no-account way back in to
    // remove their own note/email/phone. `/withdraw/<token>` is a web-app
    // page the other client-side pass still needs to add; it should POST
    // `{ token }` to `/api/requests/withdraw` the same way `/recover/:token`
    // already POSTs to `/api/recover/:token`.
    const withdrawLink = `${c.env.SITE_URL}/withdraw/${rawWithdrawToken}`;
    await sendMail(c.env, {
      kind: "request_received",
      to: input.email,
      ...requestReceivedTemplate({ listingTitle: row.title, withdrawLink }),
    });

    const result: CreateRequestResult = { id: requestId, created_at: now };
    return ok(c, result, 201);
  },
);

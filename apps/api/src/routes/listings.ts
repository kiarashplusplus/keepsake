import { Hono } from "hono";
import { captureMessage } from "@keepsake/observability/capture";
import { CreateListingInput, SetListingCategoryInput, UpdateListingInput } from "@keepsake/contracts/listing";
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
import { confirmRequest as confirmRequestTemplate } from "../email/templates/confirmRequest.js";
import { dailyIpDigest, sha256Hex } from "../lib/digest.js";
import { randomTokenRaw } from "../lib/tokens.js";
import { clientIPFrom, checkAndBumpRecipient } from "../moderation/budget.js";
import { parseIntVar, reportAutohideThreshold } from "../env.js";
import { moderateListing } from "../moderation/pipeline.js";
import { purgePhotoCache } from "../lib/photoCache.js";
import { containsContactInfo } from "../moderation/contactInfo.js";
import { serializeOwnerListing, serializePublicListing } from "../lib/serialize.js";
import { fetchAspectRows, fetchListingRow, fetchPhotoRows, replaceListingAspects } from "../lib/listingsDb.js";
import {
  ASPECT_CONTACT_INFO_MESSAGE,
  aspectsContainContactInfo,
  createListingForOwner,
} from "../listings/create.js";
import { reembedListing } from "../search/reembed.js";
import { deleteListingVector } from "../search/vectorize.js";
import { deleteCardObjects } from "../og/store.js";

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
 * Issue #188. How many "did you ask for this?" confirmations this Worker will
 * aim at one address in one day, counted per *recipient* — see
 * `checkAndBumpRecipient`, and `lib/digest.ts`'s `dailyEmailDigest` for why
 * the counter is keyed the way it is.
 *
 * Three, because the confirmation step alone does not make the flood harmless.
 * Holding the request unconfirmed is what stops a stranger being enrolled as a
 * requester and mailed the giver's address; it does not stop them being mailed
 * *at all*, and one message per listing across a public feed is a mail-bomb
 * with extra steps — the failure mode M3AAWG names in its web-form
 * recommendation, where the confirmation mail is itself the payload.
 *
 * A real person asks for one keepsake at a time and confirms the message they
 * are already waiting for. Three leaves room for the ordinary case that
 * genuinely repeats — an ask, a second ask on another listing, and one resend
 * because the first landed in spam — and turns "twenty unsolicited messages a
 * day, per attacker address" into three, total, from everyone.
 */
const DEFAULT_REQUEST_CONFIRM_ADDRESS_DAILY_BUDGET = 3;

/**
 * How long a "was this you?" link stays redeemable. Long enough to survive a
 * night, a working day, and a spam folder someone checks on a Monday; short
 * enough that an address nobody confirmed is not sitting in D1 for a week.
 * `cron/orphanSweep.ts` deletes the held row once this lapses.
 */
const REQUEST_CONFIRM_TTL_MS = 72 * 60 * 60 * 1000;

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
// Both now live in `src/listings/create.ts`, imported above, so the bulk
// submission path cannot publish an aspect this route would have refused.
// The comment block above them moved with them.

// ---------------------------------------------------------------------------
// Router-level write brake (issue #168)
// ---------------------------------------------------------------------------
// Until this existed, `adminRoutes.use("*", burst("RL_ADMIN"), adminAuth())`
// was the only router-level middleware in the Worker and every other
// owner-authenticated write reached its handler with no metering at all.
// `POST /api/listings` was carefully triple-guarded (burst + Turnstile +
// daily budget) while `PATCH /api/listings/:id` — which costs the *same*
// Workers AI calls, unconditionally scheduling the full moderation pipeline
// and, on any title/story/aspect change, a re-embed — had nothing. Measured
// by the audit: 60 PATCHes from one token and one fixed `CF-Connecting-IP`
// returned 60x200, with `EMBED_DAILY_BUDGET` and the `mod_text` pool moving
// one-for-one. `EMBED_DAILY_BUDGET` is global with no per-IP twin, so a
// couple of minutes of that loop leaves every genuine listing created for
// the rest of the UTC day with no vector at all.
//
// Deliberately router-level rather than one more per-route decision: a
// per-route decision is exactly what let this drift, and a write route added
// to this file next year is metered by default instead of by remembering.
//
// GET is skipped so the read path keeps its own `RL_READ` accounting rather
// than being charged against two bindings at once; `GET /api/listings/:id`
// already carries `burst("RL_READ")`, which is sized for reads (300/60s
// against RL_WRITE's 60/60s). Routes that already name a tighter binding
// (`RL_CREATE`, `RL_REQUEST`, `RL_REPORT`, all 5/60s) keep it and simply sit
// behind this one too — the tighter of the two is what a caller actually
// feels.
// `.on(methods, "*", ...)` rather than `.use("*", ...)` + a method check
// inside: it is the same router-level registration, applied before every
// matching route's own middleware, but Hono does the method filtering itself
// so there is no hand-written `if (c.req.method === "GET")` to get wrong, and
// `burst()` keeps its own context type instead of needing a cast. `PUT` is
// listed although this router has none today — the point of the guard is the
// route nobody has written yet.
listingRoutes.on(["POST", "PATCH", "PUT", "DELETE"], "*", burst("RL_WRITE"));

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

    const now = Date.now();

    // The listing, its photo attachments and its aspects, as one
    // `DB.batch()` transaction — see `src/listings/create.ts` for what that
    // fixed (these used to be separate awaits, so an eviction midway left a
    // listing holding only some of its photos) and for why the bulk-upload
    // submission runner shares this exact code rather than reimplementing it.
    //
    // `input.aspects` defaults to `[]` (CreateListingInput), never undefined,
    // so a brand-new listing with no confidently-read aspects gets zero rows,
    // not a skipped write.
    const { listingId: id, created } = await createListingForOwner(c.env, {
      ownerId: owner.id,
      input,
      place,
      now,
    });

    // Issue #283: `created` is false when the insert's own guard found a
    // requested photo no longer this owner's unattached orphan at the
    // instant it ran — another concurrent submission won it between the
    // pre-check `SELECT` above and this batch. Nothing was written in that
    // case (the photo-attach and aspect statements are themselves gated on
    // the listing existing), so there is nothing to clean up; the caller
    // just needs to be told rather than shown a 201 for a listing that was
    // never created.
    if (!created) {
      return fail(c, "conflict", "One or more photos were claimed by another listing — try again.", 409);
    }

    if (input.email) {
      await c.env.DB.prepare("UPDATE owners SET email = ?, email_verified_at = NULL WHERE id = ?")
        .bind(input.email, owner.id)
        .run();

      const rawVerifyToken = randomTokenRaw();
      const verifyTokenHash = await sha256Hex(rawVerifyToken);
      // `email` is issue #202, the second half of #167. That fix binds a
      // `verify_email` token to the address it was mailed to, and
      // `GET /api/me/email/verify` refuses to redeem one whose recorded
      // address is no longer the address on the owner row. This mint site was
      // outside that PR's file scope, so it wrote `NULL` here and leaned on
      // the redeem check's *second* condition — "no newer token exists for
      // this owner" — to fail closed. That fallback held, and was load-bearing
      // and undocumented: it works only because all three writers of
      // `owners.email` mint a token immediately after writing, so one edit to
      // any of them would have quietly reopened #167 with nothing failing.
      // Recording the address makes condition 1 carry the guarantee here on
      // its own, the same way it already does for `POST /api/me/email`, and
      // preflight's `verify-email-token` check now refuses a mint site that
      // omits it.
      await c.env.DB.prepare(
        `INSERT INTO recovery_tokens (id, owner_id, purpose, email, token_hash, expires_at, created_at)
         VALUES (?, ?, 'verify_email', ?, ?, ?, ?)`,
      )
        .bind(ulid(), owner.id, input.email, verifyTokenHash, now + 24 * 60 * 60 * 1000, now)
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
// `dailyBudget` on the `listing` kind, the same pool and the same per-IP
// ceiling `POST /` draws on (issue #168). One pool rather than a new
// `listing_edit` kind on purpose: an edit costs exactly the AI calls a create
// costs — one moderation run, one re-embed — so rationing the two together is
// what the number `LISTING_IP_DAILY_BUDGET = 20` already means, and it needs
// no new `[vars]` entry in three wrangler env blocks to say so.
//
// After `ownerAuth`, matching create's relative order (auth, then budget), so
// a caller with no usable token is refused before spending anyone's
// allowance. Turnstile is deliberately *not* added here: the web edit step
// mints no token today, so it would break the real edit flow rather than
// harden it. Said plainly rather than quietly skipped — the burst brake above
// and this ceiling are what stand between an owner token (minted client-side,
// `ownerAuth({createIfMissing:true})` creates the row on sight) and the
// global AI budgets.
listingRoutes.patch(
  "/:id",
  ownerAuth(),
  dailyBudget({ kind: "listing", ipDailyLimitVar: "LISTING_IP_DAILY_BUDGET", fallbackIpDailyLimit: DEFAULT_LISTING_IP_DAILY_BUDGET }),
  validateBody(UpdateListingInput),
  async (c) => {
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

    // Issue #155: `category` reaching this handler at all is a human saying
    // what their own object is. Nothing else sends it — the give flow has had
    // no category picker since #35, and the model's answer is written at
    // create and by `resuggest`, neither of which comes through here — so the
    // stamp cannot be set by a client echoing a field back unchanged today.
    // It is what makes the correction stick: without it a giver's answer and
    // a model's guess are the same string in the same column, and the next
    // `resuggest` silently replaces one with the other.
    //
    // Re-choosing the same category still stamps. A giver confirming the
    // model happened to be right is a human decision, and the point of the
    // column is whether a human has decided, not whether they changed
    // anything.
    const categoryChosenAt = input.category !== undefined ? now : row.category_chosen_at;

    const updateResult = await c.env.DB.prepare(
      `UPDATE listings SET
         title = ?, story = ?, category = ?, category_chosen_at = ?,
         country = ?, postal_code = ?, place_name = ?, admin1 = ?, lat = ?, lng = ?,
         status = 'pending', moderation_reason = NULL, version = ?, updated_at = ?
       WHERE id = ? AND version = ?`,
    )
      .bind(
        input.title ?? row.title,
        input.story ?? row.story,
        input.category ?? row.category,
        categoryChosenAt,
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

    // Issue #282: `WHERE version = ?` above is an optimistic-concurrency
    // guard, and a guard that matches zero rows is not an error — it means a
    // concurrent PATCH already bumped `version` out from under the row this
    // request read. Every other version- or claim-gated write in this
    // codebase (`bulk.ts`, `me.ts`, `recover.ts`, the report route further
    // down this file) checks `meta.changes` for exactly this reason; this
    // statement used to be the only one that didn't, which let a lost race
    // fall through and half-apply the photo/aspects writes below against a
    // row this request no longer owned.
    if ((updateResult.meta.changes ?? 0) === 0) {
      return fail(c, "conflict", "This keepsake changed elsewhere — reload and try again.", 409);
    }

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
  },
);

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
  // The rendered share cards are copies of the same photo, story and place
  // line the objects above carried, under `og/<id>/`. They are never
  // invalidated while a listing lives (content-addressed — see
  // `og/fingerprint.ts`), so deletion is the one moment anything sweeps them.
  c.executionCtx.waitUntil(deleteCardObjects(c.env, id));

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
// ---------------------------------------------------------------------------
// PUT /api/listings/:id/category — the giver's own correction (issue #155)
// ---------------------------------------------------------------------------
// Until this route, `category` had exactly one kind of writer: the model.
// The cover-photo suggestion sets it at create, `POST /api/admin/listings/
// :id/resuggest` re-reads the photo afterwards, and #35 removed the give
// flow's picker — correctly, it was a step in a flow whose product is the
// story, but it left no human path to a category at any layer. The first
// real production listing showed a visitor the single word OTHER (#135), and
// the three fixes that followed (#136, #139, #141) all improved the *model's*
// answer. If it is wrong twice, the giver — whose object it is — could not
// fix it.
//
// Not a `PATCH` carrying only `category`, for the reason written out on
// `SetListingCategoryInput`: `PATCH` bumps `version`, resets `status` to
// `pending` and re-runs the pipeline, so correcting a one-word label would
// cost a live listing its place in the feed for a moderation cycle. That is
// the tax that stops people correcting anything. A category is a closed enum
// this product defines — `CategorySchema` refuses anything else at the
// boundary — so there is no free text here for a moderator to read.
//
// No re-embed either: `embeddingText()` is title + story + aspects, and
// `category` is not part of it. The FTS index is over the same three. So
// this write changes exactly one column plus its timestamp, and nothing
// downstream needs to hear about it.
//
// `given` is refused for the same reason `PATCH` refuses it: the object has
// changed hands and the listing is a record of that now.
listingRoutes.put("/:id/category", ownerAuth(), validateBody(SetListingCategoryInput), async (c) => {
  const owner = c.get("owner");
  const id = requireParam(c, "id");
  const input = c.get("validatedBody") as SetListingCategoryInput;

  const row = await fetchListingRow(c.env, id);
  if (!row || row.owner_id !== owner.id) return fail(c, "not_found", "Listing not found.", 404);
  if (row.status === "given") {
    return fail(c, "conflict", "This keepsake has already been given and can't be edited.", 409);
  }

  const now = Date.now();
  // `category_chosen_at` is what makes the correction stick: `resuggest`
  // reads it and leaves a giver-chosen category alone. Stamped even when the
  // giver picks the category the model already chose — the column records
  // that a human decided, not that they changed something.
  await c.env.DB.prepare("UPDATE listings SET category = ?, category_chosen_at = ?, updated_at = ? WHERE id = ?")
    .bind(input.category, now, now, id)
    .run();

  const updatedRow = await fetchListingRow(c.env, id);
  if (!updatedRow) return fail(c, "internal", "Listing failed to save.", 500);
  const photos = await fetchPhotoRows(c.env, id);
  const aspects = await fetchAspectRows(c.env, id);
  return ok(c, serializeOwnerListing(updatedRow, photos, aspects));
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
// Issue #188: this used to accept any syntactically valid address, write it
// into `requests` as the requester of record, mail it a "we passed your note
// along" confirmation, and show the giver a genuine-looking ask — with
// nothing anywhere in the path establishing that the submitter controlled the
// address. `idempotency()`, `turnstile()`, `burst()` and the per-IP daily
// budget below all limit *volume*; none of them is evidence of ownership.
// `POST /api/recover` had already settled the principle for this codebase —
// it refuses to act on an unproven address — and this route acted on one and
// mailed it.
//
// What that cost the person whose address was used: mail they never asked
// for, a plausible-looking ask in a stranger's dashboard under their name,
// and — if the giver chose it — the giver's real address and reply-to
// delivered to them, with a giver now waiting to meet someone who had never
// asked for anything. Twenty times a day per attacker address, by walking the
// public feed (`UNIQUE (listing_id, email)` only stops repeats on one
// listing).
//
// So the route is confirm-then-forward now. It writes the ask down as
// `status = 'unconfirmed'`, tells nobody, and mails the address one "was this
// you?" link. `POST /api/requests/confirm` is what makes the request real.
// Three things follow, and each is load-bearing:
//
//   - The giver's side is untouched until confirmation: no `new_request`
//     mail, no `request_count`, no dashboard row.
//   - The confirmation mail carries the listing title and nothing the
//     submitter wrote, so it cannot be used to deliver text to an inbox.
//   - Unconfirmed rows are deleted, not kept, when the link lapses
//     (`cron/orphanSweep.ts`).
//
// And a fourth control that the issue did not ask for but that the flow needs
// to be honest: a per-recipient daily ceiling on the confirmation itself. The
// confirm step stops a victim being *enrolled*; on its own it does not stop
// them being *mailed*, and one message per listing across a whole feed is a
// mail-bomb whichever gate it passes through. See
// `DEFAULT_REQUEST_CONFIRM_ADDRESS_DAILY_BUDGET`.
//
// The cost, stated because it is real and belongs on the record rather than
// in a commit message: this adds a step to the one flow the product
// deliberately kept frictionless, and some genuine requests will be abandoned
// at it. That trade-off is recorded in docs/product-decisions.md.
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

    // `email_verified_at` is no longer read here: since #188 nothing on this
    // path mails the giver at all. Whether their address is confirmed is the
    // confirm route's question, asked at the moment there is something to
    // tell them.
    const owner = await c.env.DB.prepare("SELECT email, banned_at FROM owners WHERE id = ?")
      .bind(row.owner_id)
      .first<{ email: string | null; banned_at: number | null }>();

    // A banned owner's listings are meant to already be hidden (the admin
    // ban action hides every non-given one), but this is the same
    // "not found, not forbidden" treatment `ownerAuth` gives a banned
    // owner's own requests — a stranger asking about a listing gets no
    // signal that a ban is the reason it's unavailable.
    if (owner?.banned_at !== null && owner?.banned_at !== undefined) {
      return fail(c, "not_found", "Listing not found.", 404);
    }

    // Issue #189. These two conditions used to answer with distinguishable,
    // content-bearing errors — `400 "That's your own keepsake."` and
    // `409 "You've already asked for this one."` — both above the insert and
    // above both sends, which made probing completely silent to the victim:
    //
    // - the 400 confirmed a *specific email address belongs to the giver of
    //   a specific listing*, an address the privacy page promises is never
    //   shown publicly, on a stranger's say-so and with no mail sent to warn
    //   the owner. It matched on `owners.email`, not `email_verified_at`, so
    //   it confirmed unverified addresses too.
    // - the 409 confirmed *whether a named person has asked for a named
    //   keepsake* — a fact the product hides even from other requesters, and
    //   one that is sensitive in exactly the domestic situations this
    //   product invites.
    //
    // `routes/recover.ts` already enforces the opposite rule, and its comment
    // says why: a different response for an unknown address "would let a
    // caller enumerate which addresses have a Keepsake dashboard behind
    // them." Same rule here. Both cases now return the same shape the success
    // path returns, having written nothing and sent nothing.
    //
    // A *confirmed* duplicate re-sends nothing, for the reason that rule was
    // written: re-mailing on every repeat submission would turn this endpoint
    // into an unbounded mailer aimed at any address a stranger cares to name.
    // Issue #188's reissue path below is the bounded exception — it only ever
    // reissues a link to a request that is still waiting on that same address,
    // and the per-recipient ceiling caps the total either way.
    //
    // What this costs, said plainly: a giver who types their own address by
    // mistake now gets a cheerful "sent" and no request. That message was
    // worth keeping — but it belongs in the client, checked against the
    // owner address the device already knows, where it helps the one person
    // it was for without the server answering the question for everyone
    // else. `apps/web`'s `RequestSheet` still needs that follow-up.
    const isSelfRequest = Boolean(owner?.email && owner.email.toLowerCase() === input.email.toLowerCase());

    // Issue #188: `confirmed_at` and the confirm-link expiry come back too,
    // because "a row already exists for this address" now has two very
    // different meanings. A confirmed row is a real ask and this is a
    // duplicate; an *unconfirmed* row is a link sitting in an inbox that
    // nobody has clicked, and refusing to reissue it would mean one lost
    // email locks that address out of that listing until the row is swept.
    const existingRequest = await c.env.DB.prepare(
      "SELECT id, confirmed_at FROM requests WHERE listing_id = ? AND email = ?",
    )
      .bind(id, input.email)
      .first<{ id: string; confirmed_at: number | null }>();

    // A fresh ULID and the current time — the response every path below
    // returns, indistinguishable by shape, content, or the absence of an id.
    // The id is deliberately *not* the existing row's on the reissue path:
    // a ULID encodes its own mint time in its first ten characters, so
    // echoing a stored one would date the request it belongs to and hand back
    // exactly the "has this person asked for this?" oracle #189 closed.
    const acceptedResponse = (): CreateRequestResult => ({ id: ulid(), created_at: Date.now() });

    if (isSelfRequest || existingRequest?.confirmed_at != null) {
      return ok(c, acceptedResponse(), 201);
    }

    // Issue #188. Checked here — after the two silent-success branches, so a
    // duplicate never spends a real person's allowance, and *before* the
    // insert, so an address at its ceiling is never written down at all. A
    // row we will not mail is a stranger's address held for three days for
    // nothing, which is the collection this whole change exists to avoid.
    //
    // Refusing looks exactly like succeeding, for the same reason every other
    // branch here does: a distinguishable "that address has had enough mail
    // today" would answer, for any address a caller names, whether someone
    // has been aiming requests at it — which is worse than the friction it
    // would save. What the sender actually loses is small and recoverable:
    // the ask isn't stored, and tomorrow the same submission works.
    const confirmBudget = await checkAndBumpRecipient(c.env.KV, {
      kind: "request_confirm",
      address: input.email,
      dailyLimit: parseIntVar(
        "REQUEST_CONFIRM_ADDRESS_DAILY_BUDGET",
        c.env.REQUEST_CONFIRM_ADDRESS_DAILY_BUDGET,
        DEFAULT_REQUEST_CONFIRM_ADDRESS_DAILY_BUDGET,
      ),
    });
    if (!confirmBudget.allowed) {
      return ok(c, acceptedResponse(), 201);
    }

    const now = Date.now();
    // A random, single-use secret mailed to the address itself and to nowhere
    // else, so redeeming it is proof the submitter reads mail there. Only the
    // hash is stored, same as every other bearer secret this Worker mints
    // (src/lib/tokens.ts).
    const rawConfirmToken = randomTokenRaw();
    const confirmTokenHash = await sha256Hex(rawConfirmToken);
    const confirmExpiresAt = now + REQUEST_CONFIRM_TTL_MS;

    const clientIp = clientIPFrom(c.req.raw);
    const ipDigest = await dailyIpDigest(clientIp);

    let requestId: string;
    if (existingRequest) {
      // Reissue onto the held row: a fresh token and a fresh expiry, and the
      // note/phone from this submission, since this is the ask the person is
      // making now. The old token stops working the moment its hash is
      // overwritten — one live link per held request, never a growing set.
      //
      // `ip_digest` is rewritten alongside `created_at` rather than left
      // alone. The two are read together: `cron/orphanSweep.ts` clears a
      // digest 48 hours after the row's `created_at`, which is the privacy
      // page's promise. Moving the timestamp while keeping yesterday's digest
      // would quietly hold that digest past its 48 hours — and this
      // submission's address is the honest value anyway, since it is the one
      // that made the request the row now describes.
      requestId = existingRequest.id;
      await c.env.DB.prepare(
        `UPDATE requests SET note = ?, phone = ?, ip_digest = ?, confirm_token_hash = ?, confirm_expires_at = ?, created_at = ?
         WHERE id = ? AND confirmed_at IS NULL`,
      )
        .bind(input.note, input.phone ?? null, ipDigest, confirmTokenHash, confirmExpiresAt, now, requestId)
        .run();
    } else {
      requestId = ulid();

      // `status = 'unconfirmed'`: written down, and visible to nobody. The
      // giver's dashboard, the choose path and `request_count` all key off
      // `confirmed_at IS NOT NULL`, so until the link below is clicked this
      // row is a held submission and not an ask — which is the whole of the
      // fix for #188. `withdraw_token_hash` stays NULL and is minted at
      // confirmation time: a withdraw link is only useful once there is
      // something to withdraw, and mailing one now would mean mailing a
      // second bearer token to an address nobody has verified.
      await c.env.DB.prepare(
        `INSERT INTO requests (id, listing_id, note, email, phone, ip_digest, status, created_at, age_attested_at,
                               confirm_token_hash, confirm_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, 'unconfirmed', ?, ?, ?, ?)`,
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
          confirmTokenHash,
          confirmExpiresAt,
        )
        .run();
    }

    // The only message that leaves this handler, and the only one that can be
    // aimed at an address the sender may not own. Nothing has reached the
    // giver: no `new_request` mail, no `request_count` increment, no row in
    // their dashboard. `POST /api/requests/confirm` does all three, once
    // someone proves they read mail at this address.
    //
    // Deliberately never carries the note (see the template's own comment):
    // reflecting a stranger's free text into a stranger's inbox would rebuild
    // the harassment channel this step exists to close.
    const confirmLink = `${c.env.SITE_URL}/confirm/${rawConfirmToken}`;
    await sendMail(c.env, {
      kind: "confirm_request",
      to: input.email,
      ...confirmRequestTemplate({ listingTitle: row.title, confirmLink }),
    });

    const result: CreateRequestResult = { id: requestId, created_at: now };
    return ok(c, result, 201);
  },
);

/**
 * `/api/bulk/*` — estate bulk upload: batch drafts, their photos, and the
 * ceilings that bound them. Route table per the plan; house style
 * (router-level burst brake, `ownerAuth()`, `validateBody`, `ok`/`fail`)
 * copied from `routes/listings.ts`.
 *
 * ## Router-level middleware, in order
 *
 * `featureFlag(bulkUploadEnabled)` first, ahead of everything, including
 * `GET` — a disabled feature 404s the same way for a read as for a write,
 * because the point is to look like a route that was never added (see
 * `middleware/featureFlag.ts`). Then `burst("RL_WRITE")` on every non-GET
 * route, the same router-level write brake issue #168 put on
 * `listingRoutes` — see that file's comment for why this is a router-level
 * registration and not a per-route decision, and
 * `test/bulkWriteMetering.test.ts` for the enumeration that keeps it that
 * way here too.
 *
 * ## No `dailyBudget()` anywhere in this file, on purpose
 *
 * The give flow's per-IP KV ceilings (`LISTING_IP_DAILY_BUDGET`,
 * `UPLOAD_IP_DAILY_BUDGET`, …) exist because an anonymous `PUT /api/photos`
 * caller has no account to ration against — an IP address is the only
 * handle available, and `moderation/budget.ts`'s own header explains why
 * that handle is loose. A bulk caller has something better: an owner token,
 * and a per-owner-per-day counter spent exactly, in D1, by
 * `bulk/usage.ts`'s debit statements. Inheriting `dailyBudget({kind:
 * "upload", ...})` here would ration a 300-photo estate against the same
 * 60-photos-a-day ceiling a single anonymous giver gets, and refuse the
 * 61st photo of a batch this feature exists to make possible. `burst(...)`
 * stays mounted below — IP burst protection is orthogonal to a daily
 * ceiling, and a caller under the ceiling still shouldn't be able to hammer
 * the edge.
 *
 * ## No admission code
 *
 * A batch used to need an operator-minted grant id, pasted in by the giver
 * as an "admission code" and sent as `X-Bulk-Grant`. It is gone, along with
 * the `bulk_grants` table and `requireGrant()`. Nothing it bounded is
 * unbounded now: per-batch volume is `BULK_MAX_ITEMS_PER_BATCH` /
 * `BULK_MAX_PHOTOS_PER_BATCH`, enforced *as a predicate on the insert
 * itself* so a full batch refuses in the same transaction that would have
 * written the row, and total volume is `bulk_owner_usage`, which — unlike a
 * per-batch grant — survives a giver starting a second batch.
 *
 * ## Two-phase writes
 *
 * Every write that can be retried after a lost response resolves the retry
 * through a D1 unique index, not `middleware/idempotency.ts`'s KV replay
 * cache (that cache replays a *response*; nothing here needs a second
 * implementation of the same idea). `POST /batches` re-selects after an
 * `ON CONFLICT ... DO NOTHING` insert; the item and photo upserts look up by
 * client key before deciding whether there is anything left to do.
 */
import { Hono } from "hono";
import type { Country, PostalLookup } from "@keepsake/contracts/geo";
import { CreateBatchInput, SubmitBatchInput, UpdateBatchInput, UpsertBatchItemInput } from "@keepsake/contracts/bulk";
import type { Env } from "../env.js";
import {
  bulkDraftRetentionDays,
  bulkMaxItemsPerBatch,
  bulkMaxPhotosPerBatch,
  bulkOwnerDailyItems,
  bulkOwnerDailyPhotos,
  bulkOwnerDailySuggestions,
  bulkUploadEnabled,
  DEFAULT_SUGGEST_DAILY_BUDGET,
  parseIntVar,
} from "../env.js";
import { ok, fail } from "../lib/respond.js";
import { ulid } from "../lib/ids.js";
import { requireParam } from "../lib/params.js";
import { todayISO } from "../lib/day.js";
import { sha256Hex } from "../lib/digest.js";
import { checkAndBump, secondsUntilMidnightUTC } from "../moderation/budget.js";
import { ownerAuth, type OwnerRow } from "../middleware/ownerAuth.js";
import { featureFlag } from "../middleware/featureFlag.js";
import { burst } from "../middleware/rateLimit.js";
import { validateBody } from "../middleware/validate.js";
import { lookupPostalCode } from "../geo/lookup.js";
import { deletePhotoAndObjects, storePhotoUpload } from "../photos/store.js";
import { buildUsageDebitStatement, refundUsage } from "../bulk/usage.js";
import { cancelOperation, getOperationSummary, listOperationsForBatch, retryOperation, runBulkOperation, startSubmission } from "../bulk/submit.js";
import { suggestFromPhoto } from "../suggest/suggest.js";
import {
  activityBump,
  assembleBatchDetail,
  buildPhotoRepointStatements,
  findBatchByClientKey,
  findBatchById,
  findBatchPhotoByClientId,
  findItemByClientId,
  insertBatchIfAbsent,
  listBatchesForOwner,
  loadBatchDetail,
  toBatchSummary,
} from "../bulk/batches.js";

type Vars = { owner: OwnerRow; validatedBody: unknown };
export const bulkRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

bulkRoutes.use("*", featureFlag(bulkUploadEnabled));
// See this file's header for why write metering is router-level and read
// metering (`RL_READ`, below on the two GETs) is not folded into it.
bulkRoutes.on(["POST", "PATCH", "PUT", "DELETE"], "*", burst("RL_WRITE"));

const MS_PER_DAY = 86_400_000;

async function reservedPhotoId(batchId: string, clientPhotoId: string): Promise<string> {
  const digest = (await sha256Hex(`${batchId}:${clientPhotoId}`)).toUpperCase();
  return `0${digest.slice(0, 25)}`;
}

// ---------------------------------------------------------------------------
// POST /batches
// ---------------------------------------------------------------------------
// `createIfMissing: true`, the same as `POST /api/listings` and
// `PUT /api/photos` — the two other endpoints that can be a giver's very
// first request (`middleware/ownerAuth.ts`'s own words). Starting a batch
// became one the moment the admission code went away: it used to be
// impossible to reach this route without an operator having already minted
// a grant against an existing `owners` row, so a plain `ownerAuth()` was
// enough. Now someone clearing a house can land on `/bulk/new` as their
// first act on the site, and a 401 there would be the removal's own
// footgun. Every *other* bulk route keeps the plain `ownerAuth()`: there is
// no batch to reach without having created one first.
bulkRoutes.post("/batches", ownerAuth({ createIfMissing: true }), validateBody(CreateBatchInput), async (c) => {
  const owner = c.get("owner");
  const input = c.get("validatedBody") as CreateBatchInput;

  // Resolved once, here, through the same `lookupPostalCode` every listing
  // create/edit uses — every item this batch ever holds lands in the place
  // the giver saw when they set the batch up, with no per-item geo lookup.
  const place: PostalLookup | null = await lookupPostalCode(c.env, input.country, input.postal_code);
  if (!place) return fail(c, "bad_request", "We don't know that postcode yet.", 400);

  const now = Date.now();
  const { expiresAt } = activityBump(c.env, now);

  await insertBatchIfAbsent(c.env, {
    ownerId: owner.id,
    clientBatchKey: input.client_batch_key,
    name: input.name,
    sharedStory: input.shared_story ?? null,
    place,
    now,
    expiresAt,
  });

  // Re-select regardless of whether the insert above just created this row
  // or a retry found the `ON CONFLICT` branch instead — both cases resolve
  // to the same batch.
  const batch = await findBatchByClientKey(c.env, owner.id, input.client_batch_key);
  if (!batch) return fail(c, "internal", "Batch failed to save.", 500);

  const detail = await assembleBatchDetail(c.env, batch);
  return ok(c, toBatchSummary(detail), 201);
});

// ---------------------------------------------------------------------------
// GET /batches
// ---------------------------------------------------------------------------
bulkRoutes.get("/batches", burst("RL_READ"), ownerAuth(), async (c) => {
  const owner = c.get("owner");
  const rows = await listBatchesForOwner(c.env, owner.id);
  const items = await Promise.all(rows.map(async (row) => toBatchSummary(await assembleBatchDetail(c.env, row))));
  return ok(c, { items });
});

// ---------------------------------------------------------------------------
// GET /batches/:id
// ---------------------------------------------------------------------------
bulkRoutes.get("/batches/:id", burst("RL_READ"), ownerAuth(), async (c) => {
  const owner = c.get("owner");
  const id = requireParam(c, "id");

  const detail = await loadBatchDetail(c.env, id, owner.id);
  if (!detail) return fail(c, "not_found", "Batch not found.", 404);
  return ok(c, detail);
});

// ---------------------------------------------------------------------------
// PATCH /batches/:id
// ---------------------------------------------------------------------------
bulkRoutes.patch("/batches/:id", ownerAuth(), validateBody(UpdateBatchInput), async (c) => {
  const owner = c.get("owner");
  const id = requireParam(c, "id");
  const input = c.get("validatedBody") as UpdateBatchInput;

  const batch = await findBatchById(c.env, id, owner.id);
  if (!batch) return fail(c, "not_found", "Batch not found.", 404);
  if (batch.revision !== input.expected_revision) {
    return fail(c, "conflict", "This batch changed elsewhere — reload and try again.", 409);
  }

  // Re-resolve geo only when the postcode actually changed — a name-only or
  // story-only edit performs no lookup at all.
  let place: PostalLookup | null = null;
  if (input.country !== undefined || input.postal_code !== undefined) {
    const country = input.country ?? (batch.country as Country);
    const postalCode = input.postal_code ?? batch.postal_code;
    place = await lookupPostalCode(c.env, country, postalCode);
    if (!place) return fail(c, "bad_request", "We don't know that postcode yet.", 400);
  }

  const now = Date.now();
  const { updatedAt, lastActivityAt, expiresAt } = activityBump(c.env, now);

  const result = await c.env.DB.prepare(
    `UPDATE upload_batches SET
       name = ?, shared_story = ?, country = ?, postal_code = ?, place_name = ?, admin1 = ?, lat = ?, lng = ?,
       revision = revision + 1, updated_at = ?, last_activity_at = ?, expires_at = ?
     WHERE id = ? AND revision = ?`,
  )
    .bind(
      input.name ?? batch.name,
      // `shared_story` is `.nullable().optional()` — an absent key means
      // "leave it alone", an explicit `null` means "clear it", the same
      // distinction `UpdateListingInput.aspects` needs and gets in
      // `routes/listings.ts`.
      input.shared_story === undefined ? batch.shared_story : input.shared_story,
      place?.country ?? batch.country,
      place?.code ?? batch.postal_code,
      place?.place_name ?? batch.place_name,
      place?.admin1 ?? batch.admin1,
      place?.lat ?? batch.lat,
      place?.lng ?? batch.lng,
      updatedAt,
      lastActivityAt,
      expiresAt,
      id,
      batch.revision,
    )
    .run();

  if ((result.meta.changes ?? 0) === 0) {
    return fail(c, "conflict", "This batch changed elsewhere — reload and try again.", 409);
  }

  const detail = await loadBatchDetail(c.env, id, owner.id);
  if (!detail) return fail(c, "internal", "Batch failed to save.", 500);
  return ok(c, toBatchSummary(detail));
});

// ---------------------------------------------------------------------------
// DELETE /batches/:id — cancel
// ---------------------------------------------------------------------------
bulkRoutes.delete("/batches/:id", ownerAuth(), async (c) => {
  const owner = c.get("owner");
  const id = requireParam(c, "id");

  const batch = await findBatchById(c.env, id, owner.id);
  if (!batch) return fail(c, "not_found", "Batch not found.", 404);

  const now = Date.now();
  // Listings already created from this batch's items are never undone by a
  // cancel — read before the write below so the answer reflects exactly
  // what existed at the moment of cancellation, not a state the write
  // itself changes.
  const { results: publishedRows } = await c.env.DB.prepare(
    `SELECT listing_id FROM upload_batch_items WHERE batch_id = ? AND listing_id IS NOT NULL`,
  )
    .bind(id)
    .all<{ listing_id: string }>();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE upload_batches SET state = 'cancelled', cancelled_at = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
    ).bind(now, now, id),
    // Clears `retain_until` on this batch's photos so `cron/orphanSweep.ts`
    // — already tested, already backup-guarded — collects the bytes on its
    // next nightly run. See the migration's "Sweep protection" header for
    // why this is the one mechanism for reclaiming a cancelled batch's
    // photos, not a second one written here.
    c.env.DB.prepare(`UPDATE photos SET retain_until = NULL WHERE id IN (SELECT photo_id FROM upload_batch_photos WHERE batch_id = ?)`).bind(id),
  ]);

  return ok(c, { id, state: "cancelled" as const, listing_ids: publishedRows.map((row) => row.listing_id) });
});

// ---------------------------------------------------------------------------
// PUT /batches/:id/items/:clientItemId
// ---------------------------------------------------------------------------
bulkRoutes.put(
  "/batches/:id/items/:clientItemId",
  ownerAuth(),
  validateBody(UpsertBatchItemInput),
  async (c) => {
    const owner = c.get("owner");
    const batchId = requireParam(c, "id");
    const clientItemId = requireParam(c, "clientItemId");
    const input = c.get("validatedBody") as UpsertBatchItemInput;

    const batch = await findBatchById(c.env, batchId, owner.id);
    if (!batch) return fail(c, "not_found", "Batch not found.", 404);

    const existing = await findItemByClientId(c.env, batchId, clientItemId);
    const now = Date.now();
    const { updatedAt, lastActivityAt, expiresAt } = activityBump(c.env, now);
    const aspectsJson = JSON.stringify(input.fields.aspects ?? []);

    if (existing) {
      // A retry of the very first PUT for this client key (no
      // `expected_revision` — see `UpsertBatchItemInput`'s own comment on
      // why it's omitted only when creating) resolves to the row that
      // already won, unchanged, rather than a conflict: the client cannot
      // have "reviewed" a revision that never made it back to them.
      if (input.expected_revision === undefined) {
        const detail = await loadBatchDetail(c.env, batchId, owner.id);
        const item = detail?.items.find((i) => i.client_item_id === clientItemId);
        if (!item) return fail(c, "internal", "Item failed to save.", 500);
        return ok(c, item);
      }

      if (input.expected_revision !== existing.revision) {
        return fail(c, "conflict", "This item changed elsewhere — reload and try again.", 409);
      }

      const statements = [
        c.env.DB.prepare(
          `UPDATE upload_batch_items SET
             title = ?, story = ?, category = ?, aspects_json = ?, room_label = ?, lot_label = ?,
             revision = revision + 1, updated_at = ?
           WHERE id = ? AND revision = ?`,
        ).bind(
          input.fields.title ?? null,
          input.fields.story ?? null,
          input.fields.category ?? null,
          aspectsJson,
          input.room_label === undefined ? existing.room_label : input.room_label,
          input.lot_label === undefined ? existing.lot_label : input.lot_label,
          updatedAt,
          existing.id,
          existing.revision,
        ),
        c.env.DB.prepare(
          `UPDATE upload_batches SET revision = revision + 1, updated_at = ?, last_activity_at = ?, expires_at = ? WHERE id = ?`,
        ).bind(updatedAt, lastActivityAt, expiresAt, batchId),
        ...(input.photo_client_ids !== undefined ? buildPhotoRepointStatements(c.env, batchId, existing.id, input.photo_client_ids) : []),
      ];

      const results = await c.env.DB.batch(statements);
      if ((results[0]?.meta.changes ?? 0) === 0) {
        return fail(c, "conflict", "This item changed elsewhere — reload and try again.", 409);
      }

      const detail = await loadBatchDetail(c.env, batchId, owner.id);
      const item = detail?.items.find((i) => i.client_item_id === clientItemId);
      if (!item) return fail(c, "internal", "Item failed to save.", 500);
      return ok(c, item);
    }

    // Create path: the one place a new client_item_id spends this owner's
    // daily item allowance — see usage.ts's header for why the debit runs
    // in the same env.DB.batch() as the insert it pays for.
    //
    // The insert carries the per-batch cap as its own second predicate, so
    // a full batch refuses in the same statement that would have written
    // the row: `BULK_MAX_ITEMS_PER_BATCH` must never exceed the contract's
    // `MAX_BATCH_ITEMS` (`test/bulkCaps.test.ts` asserts that from the real
    // config), so an item that lands here is always one a submission can
    // still publish. Counting inside the statement rather than in a
    // `SELECT COUNT(*)` beforehand is what makes two concurrent creates at
    // the boundary unable to both pass.
    const itemId = ulid(now);
    const day = todayISO();
    const debit = buildUsageDebitStatement(c.env, { kind: "items", ownerId: owner.id, day, limit: bulkOwnerDailyItems(c.env) });

    const photoRepoint =
      input.photo_client_ids !== undefined && input.photo_client_ids.length > 0
        ? buildPhotoRepointStatements(c.env, batchId, itemId, input.photo_client_ids)
        : [];

    const statements = [
      c.env.DB.prepare(
        `INSERT INTO upload_batch_items
           (id, batch_id, client_item_id, title, story, category, aspects_json, room_label, lot_label, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM upload_batch_items WHERE batch_id = ? AND client_item_id = ?)
            AND (SELECT COUNT(*) FROM upload_batch_items WHERE batch_id = ?) < ?`,
      ).bind(
        itemId,
        batchId,
        clientItemId,
        input.fields.title ?? null,
        input.fields.story ?? null,
        input.fields.category ?? null,
        aspectsJson,
        input.room_label ?? null,
        input.lot_label ?? null,
        now,
        now,
        batchId,
        clientItemId,
        batchId,
        bulkMaxItemsPerBatch(c.env),
      ),
      debit,
      c.env.DB.prepare(
        `UPDATE upload_batches SET revision = revision + 1, updated_at = ?, last_activity_at = ?, expires_at = ? WHERE id = ?`,
      ).bind(updatedAt, lastActivityAt, expiresAt, batchId),
      ...photoRepoint,
    ];

    const results = await c.env.DB.batch(statements);
    const insertChanges = results[0]?.meta.changes ?? 0;
    const usageOk = (results[1]?.meta.changes ?? 0) > 0;

    if (insertChanges === 0) {
      // Nothing was written, but the debit beside it may have charged, so
      // give it back before answering. Two ways to get here: a concurrent
      // identical retry landed first (not reachable by a sequential retry,
      // which would have seen `existing` above and taken the update
      // branch), or the batch is full. The row's existence is what tells
      // them apart.
      if (usageOk) await refundUsage(c.env, { kind: "items", ownerId: owner.id, day });

      const detail = await loadBatchDetail(c.env, batchId, owner.id);
      const item = detail?.items.find((i) => i.client_item_id === clientItemId);
      if (item) return ok(c, item);
      return fail(
        c,
        "rate_limited",
        `This batch is full — it can hold ${bulkMaxItemsPerBatch(c.env)} items. Submit what's ready, then start another batch.`,
        429,
      );
    }

    if (!usageOk) {
      // The insert above landed unconditionally in the same transaction as
      // the refused debit. Compensate rather than leave a free item behind
      // — deleting it also releases any photo this request just re-pointed
      // onto it, via `upload_batch_photos.item_id ON DELETE SET NULL`, the
      // same FK the migration relies on for a giver splitting a group.
      await c.env.DB.prepare(`DELETE FROM upload_batch_items WHERE id = ?`).bind(itemId).run();
      return fail(c, "rate_limited", "Today's item limit for this account has been reached.", 429, {
        retryAfter: secondsUntilMidnightUTC(),
      });
    }

    const detail = await loadBatchDetail(c.env, batchId, owner.id);
    const item = detail?.items.find((i) => i.client_item_id === clientItemId);
    if (!item) return fail(c, "internal", "Item failed to save.", 500);
    return ok(c, item, 201);
  },
);

// ---------------------------------------------------------------------------
// DELETE /batches/:id/items/:clientItemId
// ---------------------------------------------------------------------------
bulkRoutes.delete("/batches/:id/items/:clientItemId", ownerAuth(), async (c) => {
  const owner = c.get("owner");
  const batchId = requireParam(c, "id");
  const clientItemId = requireParam(c, "clientItemId");

  const batch = await findBatchById(c.env, batchId, owner.id);
  if (!batch) return fail(c, "not_found", "Batch not found.", 404);

  const item = await findItemByClientId(c.env, batchId, clientItemId);
  if (!item) return fail(c, "not_found", "Item not found.", 404);

  const now = Date.now();
  const { updatedAt, lastActivityAt, expiresAt } = activityBump(c.env, now);

  await c.env.DB.batch([
    // Cascades: any batch photo pointed at this item returns to the tray
    // (`upload_batch_photos.item_id ON DELETE SET NULL`) rather than being
    // deleted with it.
    c.env.DB.prepare(`DELETE FROM upload_batch_items WHERE id = ?`).bind(item.id),
    c.env.DB.prepare(
      `UPDATE upload_batches SET revision = revision + 1, updated_at = ?, last_activity_at = ?, expires_at = ? WHERE id = ?`,
    ).bind(updatedAt, lastActivityAt, expiresAt, batchId),
  ]);

  return ok(c, { id: item.id });
});

// ---------------------------------------------------------------------------
// PUT /batches/:id/photos/:clientPhotoId
// ---------------------------------------------------------------------------
// `RL_BULK_UPLOAD`, not the give flow's `RL_UPLOAD` — see `wrangler.toml`'s
// `[[ratelimits]]` comment for why a 300-photo estate needs its own burst
// binding sized for roughly two uploads in flight, and this file's header
// for why burst protection stays mounted here even though total volume is
// already bounded exactly by this owner's daily photo ceiling.
//
// A lost response resolves through the `upload_batch_photos_client_key` D1
// unique index, same as every other write in this file — never the KV
// replay cache in `middleware/idempotency.ts`.
//
// `photoId` is deterministic (`reservedPhotoId`, a pure function of
// `(batchId, clientPhotoId)`), which makes a retried *store* safe on its own
// — `storePhotoUpload`'s `ON CONFLICT(id) DO UPDATE` (see `photos/store.ts`)
// overwrites the same row and the same R2 keys rather than duplicating. It
// does NOT, by itself, make a retried *debit* safe: whether a `photos` row
// with that id exists cannot tell "never attempted" apart from "debited,
// then the Worker was evicted before storing" — both look like "no row
// yet", and re-checking only that on every retry charges the allowance
// twice for the second case. So the reservation itself — a
// `upload_batch_photos` row with `photo_id IS NULL` — is the durable record
// of "already paid for this client key", written in the *same*
// `env.DB.batch()` call as the debit:
//   1. reserve + debit — one transaction, skipped entirely when either the
//      reservation or the photo it would name already exists (see below).
//      `upload_batch_photos_client_key` guards a concurrent double-reserve
//      the same way the item path's insert does, and the same statement
//      carries the per-batch photo cap as its own predicate.
//   2. store — `storePhotoUpload` under the deterministic id. Always run,
//      even on a resumed retry that may have already stored once: the
//      upsert makes that redundant, never wrong.
//   3. finalize — link `photo_id` and stamp `retain_until`, an upsert
//      guarded by `photo_id IS NULL` on conflict so a concurrent finalize of
//      the same reservation is a no-op the second time. `retain_until` stays
//      unset until here on purpose: if the Worker is evicted before this
//      step, the stored photo is a bare orphan (`listing_id IS NULL`,
//      `retain_until IS NULL`) that `cron/orphanSweep.ts` already knows how
//      to reclaim in 24 hours, rather than bytes protected for a week with
//      nothing pointing at them.
//
// Debit is skipped when *either* a reservation for this client key already
// exists (the eviction-after-debit case step 1 exists for) *or* a `photos`
// row already exists under the deterministic id with no reservation at all
// — the mapping row can be deleted out from under a finished upload (e.g. by
// a client retrying `DELETE` on a client key it had already re-used, or any
// other path that clears `upload_batch_photos` without touching `photos`),
// and re-linking that already-paid-for photo must not charge a second time
// either.
bulkRoutes.put("/batches/:id/photos/:clientPhotoId", burst("RL_BULK_UPLOAD"), ownerAuth(), async (c) => {
  const owner = c.get("owner");
  const batchId = requireParam(c, "id");
  const clientPhotoId = requireParam(c, "clientPhotoId");

  const batch = await findBatchById(c.env, batchId, owner.id);
  if (!batch) return fail(c, "not_found", "Batch not found.", 404);

  const respondWithSavedPhoto = async (): Promise<Response> => {
    const detail = await loadBatchDetail(c.env, batchId, owner.id);
    const photo = detail?.photos.find((p) => p.client_photo_id === clientPhotoId);
    if (!photo) return fail(c, "internal", "Photo failed to save.", 500);
    return ok(c, photo);
  };

  const existingMapping = await findBatchPhotoByClientId(c.env, batchId, clientPhotoId);
  if (existingMapping?.photo_id) {
    // Fully finished on a previous attempt — replay with no R2 work and no
    // second debit.
    return respondWithSavedPhoto();
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return fail(c, "bad_request", "Expected multipart/form-data with `full` and `thumb` files.", 400);
  }

  const now = Date.now();
  const day = todayISO();
  const photoId = await reservedPhotoId(batchId, clientPhotoId);

  // Recovery fallback for a missing (not merely unresolved) mapping row —
  // see the header above. Only consulted when there is no reservation at
  // all; an unresolved reservation (`existingMapping` truthy, `photo_id`
  // still null) already proves the allowance was spent without this lookup.
  const retainedPhoto = existingMapping
    ? null
    : await c.env.DB.prepare("SELECT id FROM photos WHERE id = ? AND owner_id = ?").bind(photoId, owner.id).first<{ id: string }>();

  if (!existingMapping && !retainedPhoto) {
    // Step 1: reserve and debit atomically. The ceiling is checked, and
    // spent, *before* a single byte reaches R2 or a `photos` row exists —
    // fail closed with nothing durable left behind (the reservation this
    // call just inserted is deleted below on that path).
    const reservationId = ulid(now);
    const photoLimit = bulkMaxPhotosPerBatch(c.env);
    const debit = buildUsageDebitStatement(c.env, { kind: "photos", ownerId: owner.id, day, limit: bulkOwnerDailyPhotos(c.env) });
    const statements = [
      c.env.DB.prepare(
        `INSERT INTO upload_batch_photos (id, batch_id, client_photo_id, photo_id, item_id, position, created_at, updated_at)
         SELECT ?, ?, ?, NULL, NULL, 0, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM upload_batch_photos WHERE batch_id = ? AND client_photo_id = ?)
            AND (SELECT COUNT(*) FROM upload_batch_photos WHERE batch_id = ?) < ?`,
      ).bind(reservationId, batchId, clientPhotoId, now, now, batchId, clientPhotoId, batchId, photoLimit),
      debit,
    ];
    const results = await c.env.DB.batch(statements);
    const insertChanges = results[0]?.meta.changes ?? 0;
    const usageOk = (results[1]?.meta.changes ?? 0) > 0;

    if (insertChanges === 0) {
      // Nothing was reserved, so refund whatever the debit beside it
      // charged, then work out which of the two guards refused: a
      // concurrent identical request that reserved this slot first (not
      // reachable by a sequential retry — that would have seen
      // `existingMapping` above), or a full batch.
      if (usageOk) await refundUsage(c.env, { kind: "photos", ownerId: owner.id, day });

      const winner = await findBatchPhotoByClientId(c.env, batchId, clientPhotoId);
      if (!winner) {
        return fail(
          c,
          "rate_limited",
          `This batch is full — it can hold ${photoLimit} photos. Submit what's ready, then start another batch.`,
          429,
        );
      }
      if (winner.photo_id) return respondWithSavedPhoto();
      // Else: winner reserved (and debited) but hasn't stored yet — fall
      // through to step 2 with the same deterministic id.
    } else if (!usageOk) {
      // We own the reservation and the ceiling refused — delete it so an
      // exhausted allowance fails closed with zero storage side effects: no
      // R2 bytes (never attempted), no `photos` row (never attempted), and
      // now no mapping row either.
      await c.env.DB.prepare(`DELETE FROM upload_batch_photos WHERE id = ?`).bind(reservationId).run();
      return fail(c, "rate_limited", "Today's photo limit for this account has been reached.", 429, {
        retryAfter: secondsUntilMidnightUTC(),
      });
    }
  }
  // Else: either `existingMapping` was already reserved (and, atomically,
  // already debited) by a previous attempt, or `retainedPhoto` shows this
  // client key already paid for a stored photo with no reservation left to
  // prove it — either way, resume at step 2 with no second debit.

  // Step 2: store the bytes under the deterministic id.
  const stored = await storePhotoUpload(c.env, { ownerId: owner.id, form, photoId });
  if (!stored.ok) {
    return fail(c, stored.code, stored.message, stored.status, stored.issues ? { issues: stored.issues } : {});
  }

  // Step 3: finalize, now that the FK's target exists. An upsert rather than
  // a bare `UPDATE` because the recovery fallback above can reach here with
  // no mapping row at all (`retainedPhoto`, mapping row missing) as well as
  // with an unresolved one (`existingMapping`, `photo_id IS NULL`) — the
  // `WHERE photo_id IS NULL` on the conflict branch is what keeps a
  // concurrent finalize of the same reservation a no-op the second time.
  const { updatedAt, lastActivityAt, expiresAt } = activityBump(c.env, now);
  const retainUntil = now + bulkDraftRetentionDays(c.env) * MS_PER_DAY;
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE photos SET retain_until = ? WHERE id = ?`).bind(retainUntil, photoId),
    c.env.DB.prepare(
      `INSERT INTO upload_batch_photos (id, batch_id, client_photo_id, photo_id, item_id, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 0, ?, ?)
       ON CONFLICT(batch_id, client_photo_id) DO UPDATE SET photo_id = excluded.photo_id, updated_at = excluded.updated_at
        WHERE upload_batch_photos.photo_id IS NULL`,
    ).bind(ulid(now), batchId, clientPhotoId, photoId, now, now),
    c.env.DB.prepare(
      `UPDATE upload_batches SET revision = revision + 1, updated_at = ?, last_activity_at = ?, expires_at = ? WHERE id = ?`,
    ).bind(updatedAt, lastActivityAt, expiresAt, batchId),
  ]);

  const detail = await loadBatchDetail(c.env, batchId, owner.id);
  const photo = detail?.photos.find((p) => p.client_photo_id === clientPhotoId);
  if (!photo) return fail(c, "internal", "Photo failed to save.", 500);
  return ok(c, photo, 201);
});

// ---------------------------------------------------------------------------
// DELETE /batches/:id/photos/:clientPhotoId
// ---------------------------------------------------------------------------
bulkRoutes.delete("/batches/:id/photos/:clientPhotoId", ownerAuth(), async (c) => {
  const owner = c.get("owner");
  const batchId = requireParam(c, "id");
  const clientPhotoId = requireParam(c, "clientPhotoId");

  const batch = await findBatchById(c.env, batchId, owner.id);
  if (!batch) return fail(c, "not_found", "Batch not found.", 404);

  const mapping = await findBatchPhotoByClientId(c.env, batchId, clientPhotoId);
  if (!mapping) return fail(c, "not_found", "Photo not found.", 404);

  const photoRow = await c.env.DB.prepare("SELECT id, r2_key_full, r2_key_thumb FROM photos WHERE id = ?")
    .bind(mapping.photo_id)
    .first<{ id: string; r2_key_full: string; r2_key_thumb: string }>();

  if (photoRow) {
    // Deletes the `photos` row too, which cascades this batch's mapping row
    // with it (`upload_batch_photos.photo_id ON DELETE CASCADE`) — no
    // separate delete of the mapping needed.
    await deletePhotoAndObjects(c.env, photoRow);
  } else {
    // Either the mapping outlived its photo somehow (shouldn't happen given
    // the FK, but this route must not 500 over it), or — now that a mapping
    // can exist with `photo_id IS NULL`, see the migration's comment on that
    // column — this is an unresolved reservation whose upload never finished
    // storing. Either way there is no `photos` row to delete, only the
    // mapping.
    await c.env.DB.prepare(`DELETE FROM upload_batch_photos WHERE id = ?`).bind(mapping.id).run();
  }

  const now = Date.now();
  const { updatedAt, lastActivityAt, expiresAt } = activityBump(c.env, now);
  await c.env.DB.prepare(`UPDATE upload_batches SET revision = revision + 1, updated_at = ?, last_activity_at = ?, expires_at = ? WHERE id = ?`)
    .bind(updatedAt, lastActivityAt, expiresAt, batchId)
    .run();

  // `photo_id` can be null for an unresolved reservation (see above); the
  // client key still names *something* to report back.
  return ok(c, { id: mapping.photo_id ?? mapping.id });
});

// ---------------------------------------------------------------------------
// POST /batches/:id/photos/:clientPhotoId/suggest
// ---------------------------------------------------------------------------
interface BulkSuggestPhotoRow {
  id: string;
  owner_id: string;
  r2_key_thumb: string;
  content_type: string;
}

/**
 * The batch workspace's cover suggestion — same job as `POST
 * /api/photos/:id/suggest` (`routes/photos.ts`), reusing `suggestFromPhoto`
 * rather than a second implementation, and returning the identical
 * `{ suggestion }` shape (`PhotoSuggestionSchema` from
 * `@keepsake/contracts/photo`; `suggestion` is `null` on a failed or
 * unparseable model reply, same as the give flow — never a 500).
 *
 * Two things differ from the give-flow route, both deliberate:
 *
 *  - **Lookup.** Scoped to owner *and* batch — `findBatchById` first, then
 *    `findBatchPhotoByClientId` — so naming a batch or photo id that isn't
 *    the caller's, or isn't in this batch, 404s exactly like one that
 *    doesn't exist, matching every other lookup in this router (never 403).
 *  - **The ceiling.** Charged against `bulk_owner_usage.suggestions_used`
 *    with a guarded D1 upsert (`buildUsageDebitStatement`), not the give
 *    flow's per-IP KV `suggest` budget — see this file's header for why a
 *    bulk caller's ceiling lives in D1, never KV: `SUGGEST_IP_DAILY_BUDGET`
 *    defaults to 30/day, which a 100-item estate exhausts on item 31, and a
 *    KV counter is eventually consistent by its own documentation so it
 *    could not bound a batch exactly at any size.
 *
 * The **global** `SUGGEST_DAILY_BUDGET` runaway ceiling still applies, and
 * that is a deliberate choice, not an oversight: unlike the per-IP KV budget
 * (which rations *one caller*, a job `bulk_owner_usage` already does
 * exactly), the global counter protects the shared Workers AI
 * allocation the whole account draws from — the same reason
 * `search/reembed.ts`'s `embed` kind checks the global ceiling with no
 * `ipDailyLimit` even though its only caller is an already-authenticated
 * write path. A bulk vision call spends the same allocation a give-flow
 * autofill call does, so it must count against the same account-wide ceiling
 * that protects it; only the per-caller half of `checkAndBump` is skipped
 * here, not both.
 */
bulkRoutes.post("/batches/:id/photos/:clientPhotoId/suggest", ownerAuth(), async (c) => {
  const owner = c.get("owner");
  const batchId = requireParam(c, "id");
  const clientPhotoId = requireParam(c, "clientPhotoId");

  const batch = await findBatchById(c.env, batchId, owner.id);
  if (!batch) return fail(c, "not_found", "Batch not found.", 404);

  const mapping = await findBatchPhotoByClientId(c.env, batchId, clientPhotoId);
  if (!mapping) return fail(c, "not_found", "Photo not found.", 404);

  const photo = await c.env.DB.prepare("SELECT id, owner_id, r2_key_thumb, content_type FROM photos WHERE id = ?")
    .bind(mapping.photo_id)
    .first<BulkSuggestPhotoRow>();
  if (!photo || photo.owner_id !== owner.id) return fail(c, "not_found", "Photo not found.", 404);

  // Global runaway ceiling only — see this route's own doc comment for why
  // the give flow's per-IP KV budget is not inherited here.
  const dailyLimit = parseIntVar("SUGGEST_DAILY_BUDGET", c.env.SUGGEST_DAILY_BUDGET, DEFAULT_SUGGEST_DAILY_BUDGET);
  const globalBudget = await checkAndBump(c.env.KV, { kind: "suggest", dailyLimit });
  if (!globalBudget.allowed) {
    return fail(c, "rate_limited", "Daily suggestion limit reached — please try again tomorrow.", 429, {
      ...(globalBudget.retryAfter !== undefined ? { retryAfter: globalBudget.retryAfter } : {}),
    });
  }

  // The ceiling is checked, and spent, *before* the AI call — fail closed
  // on an exhausted allowance with no vision call made. Nothing to
  // compensate here, unlike the item and photo paths: this write creates no
  // row of its own for the debit to be paired with.
  const debit = buildUsageDebitStatement(c.env, {
    kind: "suggestions",
    ownerId: owner.id,
    day: todayISO(),
    limit: bulkOwnerDailySuggestions(c.env),
  });
  const usageOk = ((await debit.run()).meta.changes ?? 0) > 0;
  if (!usageOk) {
    return fail(c, "rate_limited", "Today's suggestion limit for this account has been reached.", 429, {
      retryAfter: secondsUntilMidnightUTC(),
    });
  }

  const result = await suggestFromPhoto(c.env, photo);
  return ok(c, { suggestion: result.suggestion });
});

// ---------------------------------------------------------------------------
// POST /batches/:id/submit
// ---------------------------------------------------------------------------
// `startSubmission` spends no allowance of its own — the items and photos
// it publishes already paid for themselves, one at a time, at
// `PUT /batches/:id/items/:clientItemId` and
// `PUT /batches/:id/photos/:clientPhotoId`.
bulkRoutes.post("/batches/:id/submit", ownerAuth(), validateBody(SubmitBatchInput), async (c) => {
  const owner = c.get("owner");
  const batchId = requireParam(c, "id");
  const input = c.get("validatedBody") as SubmitBatchInput;

  const result = await startSubmission(c.env, { ownerId: owner.id, batchId, input });
  if (!result.ok) {
    return fail(c, result.code, result.message, result.status);
  }

  // Eager first attempt so a small batch doesn't wait up to three minutes
  // for `bulkRunner`'s `*/3` cron tick — `runBulkOperation` itself is what
  // makes this safe to fire and forget: it's idempotent, lease-guarded, and
  // the cron picks the operation right back up if this `waitUntil` never
  // runs at all (Worker eviction, a thrown exception, anything). Not awaited
  // — the response is the *accepted* operation, not the finished one.
  c.executionCtx.waitUntil(runBulkOperation(c.env, result.operation.id));

  return ok(c, result.operation, 202);
});

// ---------------------------------------------------------------------------
// GET /batches/:id/operations
// ---------------------------------------------------------------------------
bulkRoutes.get("/batches/:id/operations", burst("RL_READ"), ownerAuth(), async (c) => {
  const owner = c.get("owner");
  const batchId = requireParam(c, "id");

  const batch = await findBatchById(c.env, batchId, owner.id);
  if (!batch) return fail(c, "not_found", "Batch not found.", 404);

  const items = await listOperationsForBatch(c.env, { batchId, ownerId: owner.id });
  return ok(c, { items });
});

// ---------------------------------------------------------------------------
// GET /operations/:id
// ---------------------------------------------------------------------------
bulkRoutes.get("/operations/:id", burst("RL_READ"), ownerAuth(), async (c) => {
  const owner = c.get("owner");
  const operationId = requireParam(c, "id");

  const operation = await getOperationSummary(c.env, { operationId, ownerId: owner.id });
  if (!operation) return fail(c, "not_found", "Operation not found.", 404);
  return ok(c, operation);
});

// ---------------------------------------------------------------------------
// POST /operations/:id/retry
// ---------------------------------------------------------------------------
bulkRoutes.post("/operations/:id/retry", ownerAuth(), async (c) => {
  const owner = c.get("owner");
  const operationId = requireParam(c, "id");

  const result = await retryOperation(c.env, { ownerId: owner.id, operationId });
  if (!result) return fail(c, "not_found", "Operation not found.", 404);

  // Only worth an eager attempt when there's actually something new queued
  // — see `retryOperation`'s own header for why a no-op call (nothing was
  // failing, or the operation wasn't `done` yet) must not disturb anything.
  if (result.requeued > 0) {
    c.executionCtx.waitUntil(runBulkOperation(c.env, operationId));
  }

  return ok(c, result.operation);
});

// ---------------------------------------------------------------------------
// DELETE /operations/:id — cancel unstarted work
// ---------------------------------------------------------------------------
bulkRoutes.delete("/operations/:id", ownerAuth(), async (c) => {
  const owner = c.get("owner");
  const operationId = requireParam(c, "id");

  const result = await cancelOperation(c.env, { ownerId: owner.id, operationId });
  if (!result) return fail(c, "not_found", "Operation not found.", 404);

  return ok(c, { operation: result.operation, listing_ids: result.listingIds });
});

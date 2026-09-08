/**
 * `/api/bulk/*` — estate bulk upload: batch drafts, their photos, and the
 * admission grants that bound them. Route table per the plan; house style
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
 * that handle is loose. A bulk caller has something better: admission,
 * proved by `requireGrant()` and spent exactly, in D1, by
 * `bulk/grants.ts`'s debit statements. Inheriting `dailyBudget({kind:
 * "upload", ...})` here would ration a 300-photo estate against the same
 *60-photos-a-day ceiling a single anonymous giver gets, and refuse the
 * 61st photo of a batch an operator admitted for exactly this. `burst(...)`
 * stays mounted below — IP burst protection is orthogonal to admission, and
 * a caller who has been admitted still shouldn't be able to hammer the edge.
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
import { bulkDraftRetentionDays, bulkOwnerDailyItems, bulkOwnerDailyPhotos, bulkUploadEnabled } from "../env.js";
import { ok, fail } from "../lib/respond.js";
import { ulid } from "../lib/ids.js";
import { requireParam } from "../lib/params.js";
import { todayISO } from "../lib/day.js";
import { sha256Hex } from "../lib/digest.js";
import { secondsUntilMidnightUTC } from "../moderation/budget.js";
import { ownerAuth, type OwnerRow } from "../middleware/ownerAuth.js";
import { requireGrant, type GrantVariables } from "../middleware/bulkGrant.js";
import { featureFlag } from "../middleware/featureFlag.js";
import { burst } from "../middleware/rateLimit.js";
import { validateBody } from "../middleware/validate.js";
import { lookupPostalCode } from "../geo/lookup.js";
import { deletePhotoAndObjects, storePhotoUpload } from "../photos/store.js";
import { bindGrantToBatch, buildItemDebitStatements, buildPhotoDebitStatements, settleDebit } from "../bulk/grants.js";
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
import { cancelOperation, getOperationSummary, listOperationsForBatch, retryOperation, runBulkOperation, startSubmission } from "../bulk/submit.js";

type Vars = { owner: OwnerRow; validatedBody: unknown } & GrantVariables;
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
bulkRoutes.post("/batches", ownerAuth(), requireGrant(), validateBody(CreateBatchInput), async (c) => {
  const owner = c.get("owner");
  const grant = c.get("grant");
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

  // First use only — `bindGrantToBatch`'s own `WHERE batch_id IS NULL`
  // guard is what makes a retry of this same request a no-op the second
  // time.
  await bindGrantToBatch(c.env, grant.id, batch.id);

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
bulkRoutes.patch("/batches/:id", ownerAuth(), requireGrant(), validateBody(UpdateBatchInput), async (c) => {
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
  requireGrant(),
  validateBody(UpsertBatchItemInput),
  async (c) => {
    const owner = c.get("owner");
    const grant = c.get("grant");
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

    // Create path: the one place a new client_item_id spends the batch's
    // per-item admission — see grants.ts's header for why the debit runs in
    // the same env.DB.batch() as the insert it pays for.
    const itemId = ulid(now);
    const day = todayISO();
    const debit = buildItemDebitStatements(c.env, { grant, ownerId: owner.id, day, limit: bulkOwnerDailyItems(c.env), now });

    const photoRepoint =
      input.photo_client_ids !== undefined && input.photo_client_ids.length > 0
        ? buildPhotoRepointStatements(c.env, batchId, itemId, input.photo_client_ids)
        : [];

    const statements = [
      c.env.DB.prepare(
        `INSERT INTO upload_batch_items
           (id, batch_id, client_item_id, title, story, category, aspects_json, room_label, lot_label, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM upload_batch_items WHERE batch_id = ? AND client_item_id = ?)`,
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
      ),
      ...debit.statements,
      c.env.DB.prepare(
        `UPDATE upload_batches SET revision = revision + 1, updated_at = ?, last_activity_at = ?, expires_at = ? WHERE id = ?`,
      ).bind(updatedAt, lastActivityAt, expiresAt, batchId),
      ...photoRepoint,
    ];

    const results = await c.env.DB.batch(statements);
    const insertChanges = results[0]?.meta.changes ?? 0;
    const grantOk = (results[1 + debit.grantResultIndex]?.meta.changes ?? 0) > 0;
    const usageOk = (results[1 + debit.usageResultIndex]?.meta.changes ?? 0) > 0;
    const admitted = await settleDebit(c.env, { grantId: grant.id, ownerId: owner.id, day, kind: "items", grantOk, usageOk });

    if (insertChanges === 0) {
      // A concurrent identical retry landed first — not reachable by a
      // sequential retry (which would have seen `existing` above and taken
      // the update branch), only a genuine race. `settleDebit` above still
      // ran, so this request's own charge (if any) was corrected for
      // whichever half disagreed; the tiny remaining window — both halves
      // agreeing to admit twice for one logical create — is the same one
      // `routes/bulk.ts`'s header on the photo path already names.
      const detail = await loadBatchDetail(c.env, batchId, owner.id);
      const item = detail?.items.find((i) => i.client_item_id === clientItemId);
      if (!item) return fail(c, "internal", "Item failed to save.", 500);
      return ok(c, item);
    }

    if (!admitted) {
      // The insert above landed unconditionally in the same transaction as
      // the refused debit. Compensate rather than leave a free item behind
      // — deleting it also releases any photo this request just re-pointed
      // onto it, via `upload_batch_photos.item_id ON DELETE SET NULL`, the
      // same FK the migration relies on for a giver splitting a group.
      await c.env.DB.prepare(`DELETE FROM upload_batch_items WHERE id = ?`).bind(itemId).run();
      const message = grantOk
        ? "Today's item limit for this account has been reached."
        : "Your admission grant has no items left — ask the operator for a fresh one.";
      return fail(c, "rate_limited", message, 429, grantOk ? { retryAfter: secondsUntilMidnightUTC() } : {});
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
bulkRoutes.put("/batches/:id/photos/:clientPhotoId", burst("RL_UPLOAD"), ownerAuth(), requireGrant(), async (c) => {
  const owner = c.get("owner");
  const grant = c.get("grant");
  const batchId = requireParam(c, "id");
  const clientPhotoId = requireParam(c, "clientPhotoId");

  const batch = await findBatchById(c.env, batchId, owner.id);
  if (!batch) return fail(c, "not_found", "Batch not found.", 404);

  // Phase 1: this is how a lost response resolves — a D1 unique index
  // (`upload_batch_photos_client_key`), not the KV replay cache in
  // `middleware/idempotency.ts`.
  const existingMapping = await findBatchPhotoByClientId(c.env, batchId, clientPhotoId);
  if (existingMapping) {
    const detail = await loadBatchDetail(c.env, batchId, owner.id);
    const photo = detail?.photos.find((p) => p.client_photo_id === clientPhotoId);
    if (!photo) return fail(c, "internal", "Photo failed to save.", 500);
    return ok(c, photo);
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
  const retainedPhoto = await c.env.DB.prepare("SELECT id FROM photos WHERE id = ? AND owner_id = ?")
    .bind(photoId, owner.id)
    .first<{ id: string }>();

  // Admission is checked, and spent, *before* a single byte reaches R2 —
  // fail closed on an exhausted grant or ceiling with nothing written
  // anywhere. `settleDebit` corrects the one case where only one of the two
  // guarded statements below actually fired (see its own doc comment).
  if (!retainedPhoto) {
    const debit = buildPhotoDebitStatements(c.env, { grant, ownerId: owner.id, day, limit: bulkOwnerDailyPhotos(c.env), now });
    const debitResults = await c.env.DB.batch(debit.statements);
    const grantOk = (debitResults[debit.grantResultIndex]?.meta.changes ?? 0) > 0;
    const usageOk = (debitResults[debit.usageResultIndex]?.meta.changes ?? 0) > 0;
    const admitted = await settleDebit(c.env, { grantId: grant.id, ownerId: owner.id, day, kind: "photos", grantOk, usageOk });
    if (!admitted) {
      const message = grantOk
        ? "Today's photo limit for this account has been reached."
        : "Your admission grant has no photos left — ask the operator for a fresh one.";
      return fail(c, "rate_limited", message, 429, grantOk ? { retryAfter: secondsUntilMidnightUTC() } : {});
    }
  }

  if (!retainedPhoto) {
    const stored = await storePhotoUpload(c.env, { ownerId: owner.id, form, photoId });
    if (!stored.ok) {
      return fail(c, stored.code, stored.message, stored.status, stored.issues ? { issues: stored.issues } : {});
    }
  }

  const { updatedAt, lastActivityAt, expiresAt } = activityBump(c.env, now);
  const retainUntil = now + bulkDraftRetentionDays(c.env) * MS_PER_DAY;

  // Phase 2, now that the FK's target exists: link the photo into this
  // batch's tray and protect it from the sweep, in one transaction. Guarded
  // by `NOT EXISTS` so a genuine concurrent race on the same client key
  // still can't produce two mapping rows for one `client_photo_id`.
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE photos SET retain_until = ? WHERE id = ?`).bind(retainUntil, photoId),
    c.env.DB.prepare(
      `INSERT INTO upload_batch_photos (id, batch_id, client_photo_id, photo_id, item_id, position, created_at, updated_at)
       SELECT ?, ?, ?, ?, NULL, 0, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM upload_batch_photos WHERE batch_id = ? AND client_photo_id = ?)`,
    ).bind(ulid(now), batchId, clientPhotoId, photoId, now, now, batchId, clientPhotoId),
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
    // The mapping outlived its photo somehow (shouldn't happen given the
    // FK, but this route must not 500 over it) — clear the mapping directly.
    await c.env.DB.prepare(`DELETE FROM upload_batch_photos WHERE id = ?`).bind(mapping.id).run();
  }

  const now = Date.now();
  const { updatedAt, lastActivityAt, expiresAt } = activityBump(c.env, now);
  await c.env.DB.prepare(`UPDATE upload_batches SET revision = revision + 1, updated_at = ?, last_activity_at = ?, expires_at = ? WHERE id = ?`)
    .bind(updatedAt, lastActivityAt, expiresAt, batchId)
    .run();

  return ok(c, { id: mapping.photo_id });
});

// ---------------------------------------------------------------------------
// POST /batches/:id/submit
// ---------------------------------------------------------------------------
// No `requireGrant()` here, deliberately: `startSubmission` spends no
// admission of its own — the items and photos it publishes already paid for
// themselves, one at a time, at `PUT /batches/:id/items/:clientItemId` and
// `PUT /batches/:id/photos/:clientPhotoId`. `DELETE /batches/:id` is the
// existing precedent for a bulk write that needs no grant.
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

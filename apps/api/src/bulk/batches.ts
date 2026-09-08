/**
 * Batch/item/photo persistence and serialization for estate bulk upload.
 *
 * ## Reads never move the clock; writes always do
 *
 * `last_activity_at`/`expires_at` exist so `cron/orphanSweep.ts` (via
 * `photos.retain_until`, see the migration's "Sweep protection" header) can
 * reclaim a batch nobody is touching any more, while a batch someone is
 * actively working survives. Every function here that performs a
 * *deliberate* write — create, edit, upsert, delete, upload — bumps
 * `revision`, `updated_at`, `last_activity_at`, and pushes `expires_at`
 * `bulkDraftRetentionDays` forward from now. Every read-only loader in this
 * file touches none of those columns. A tab left open polling `GET
 * /batches/:id` must not be indistinguishable, to the sweep, from a giver
 * still working.
 *
 * ## `ready`/`blocked_reason` restate nothing
 *
 * `computeItemView` below runs the real `CreateListingInput` (from
 * `@keepsake/contracts/listing`) over the assembled item. It is the *only*
 * place in this module that knows what makes a listing publishable, and it
 * knows it by asking the schema, not by re-describing it. `firstIssueSentence`
 * turns whichever field zod rejected first into a giver-facing sentence —
 * the wording is new, the rule it is describing is not.
 *
 * ## No N+1
 *
 * `loadBatchDetail` issues exactly two child queries — all of a batch's
 * items, all of its photos — regardless of how many items or photos exist,
 * and assembles the grouping in memory. Same shape as `routes/admin.ts`'s
 * queue page (`fetchPhotoRowsForListings` et al.) and for the same reason.
 */
import { z } from "zod";
import type { Country, PostalLookup } from "@keepsake/contracts/geo";
import { CreateListingInput, STORY_MIN, type Category } from "@keepsake/contracts/listing";
import type {
  BatchDetail,
  BatchItemState,
  BatchItemSummary,
  BatchPhotoSummary,
  BatchState,
  BatchSummary,
} from "@keepsake/contracts/bulk";
import { ulid } from "../lib/ids.js";
import type { Env } from "../env.js";
import { bulkDraftRetentionDays } from "../env.js";

const MS_PER_DAY = 86_400_000;

export interface BatchRow {
  id: string;
  owner_id: string;
  client_batch_key: string;
  name: string;
  shared_story: string | null;
  country: string;
  postal_code: string;
  place_name: string;
  admin1: string | null;
  lat: number;
  lng: number;
  state: string;
  revision: number;
  last_activity_at: number;
  expires_at: number;
  created_at: number;
  updated_at: number;
  cancelled_at: number | null;
}

export interface BatchItemRow {
  id: string;
  batch_id: string;
  client_item_id: string;
  title: string | null;
  story: string | null;
  category: string | null;
  aspects_json: string | null;
  room_label: string | null;
  lot_label: string | null;
  state: string;
  revision: number;
  failure_code: string | null;
  failure_detail: string | null;
  listing_id: string | null;
  created_at: number;
  updated_at: number;
  submitted_at: number | null;
}

export interface BatchPhotoRow {
  id: string;
  batch_id: string;
  client_photo_id: string;
  /**
   * NULL until the reserved upload actually finishes storing — see the
   * migration's comment on this column and `routes/bulk.ts`'s reserve →
   * debit → store → finalize sequence. `findBatchPhotoByClientId` returns
   * rows in either state (the PUT handler needs to see an unresolved
   * reservation to resume it and skip a second debit); `loadPhotosForBatch`
   * filters them out, so a batch's assembled photo list — and thus
   * `photo_count` — never includes an upload that hasn't actually landed.
   */
  photo_id: string | null;
  item_id: string | null;
  position: number;
  created_at: number;
  updated_at: number;
}

/** `BatchPhotoRow` narrowed to rows `loadPhotosForBatch` actually returns —
 * its query filters to `photo_id IS NOT NULL`, so every row reaching
 * `buildPhotoSummary` really does have one. */
export type ResolvedBatchPhotoRow = BatchPhotoRow & { photo_id: string };

const BATCH_COLUMNS =
  "id, owner_id, client_batch_key, name, shared_story, country, postal_code, place_name, admin1, lat, lng, state, revision, last_activity_at, expires_at, created_at, updated_at, cancelled_at";
const ITEM_COLUMNS =
  "id, batch_id, client_item_id, title, story, category, aspects_json, room_label, lot_label, state, revision, failure_code, failure_detail, listing_id, created_at, updated_at, submitted_at";
const PHOTO_COLUMNS = "id, batch_id, client_photo_id, photo_id, item_id, position, created_at, updated_at";

/** What every deliberate write bumps. Centralized so "create, edit, upsert,
 * delete, upload all push the clock the same way" is one function, not a
 * rule copied at every call site in `routes/bulk.ts`. */
export function activityBump(env: Env, now: number): { updatedAt: number; lastActivityAt: number; expiresAt: number } {
  return { updatedAt: now, lastActivityAt: now, expiresAt: now + bulkDraftRetentionDays(env) * MS_PER_DAY };
}

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

export async function findBatchByClientKey(env: Env, ownerId: string, clientBatchKey: string): Promise<BatchRow | null> {
  const row = await env.DB.prepare(`SELECT ${BATCH_COLUMNS} FROM upload_batches WHERE owner_id = ? AND client_batch_key = ?`)
    .bind(ownerId, clientBatchKey)
    .first<BatchRow>();
  return row ?? null;
}

/**
 * Ownership lives in the query, not in a check afterward — `owner_id = ?`
 * right next to `id = ?`. A batch id that exists but belongs to someone
 * else has to come back exactly like a batch id that doesn't exist at all;
 * a helper that fetched by id alone and let the caller compare
 * `row.owner_id === ownerId` is one accidentally-deleted line away from a
 * cross-owner read. `test/bulkOwnership.test.ts` breaks this guard on
 * purpose to prove it.
 */
export async function findBatchById(env: Env, id: string, ownerId: string): Promise<BatchRow | null> {
  const row = await env.DB.prepare(`SELECT ${BATCH_COLUMNS} FROM upload_batches WHERE id = ? AND owner_id = ?`)
    .bind(id, ownerId)
    .first<BatchRow>();
  return row ?? null;
}

export interface InsertBatchArgs {
  ownerId: string;
  clientBatchKey: string;
  name: string;
  sharedStory: string | null;
  place: PostalLookup;
  now: number;
  expiresAt: number;
}

/** `ON CONFLICT(owner_id, client_batch_key) DO NOTHING` — the retry-safety
 * the migration's unique index exists for. The caller re-selects with
 * {@link findBatchByClientKey} afterward regardless of whether this
 * inserted a fresh row or a retry found one already there, so a dropped
 * response on the very first `POST /batches` resolves to the same batch
 * every time. */
export async function insertBatchIfAbsent(env: Env, args: InsertBatchArgs): Promise<void> {
  const id = ulid(args.now);
  await env.DB.prepare(
    `INSERT INTO upload_batches
       (id, owner_id, client_batch_key, name, shared_story, country, postal_code, place_name, admin1, lat, lng,
        state, revision, last_activity_at, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?, ?)
     ON CONFLICT(owner_id, client_batch_key) DO NOTHING`,
  )
    .bind(
      id,
      args.ownerId,
      args.clientBatchKey,
      args.name,
      args.sharedStory,
      args.place.country,
      args.place.code,
      args.place.place_name,
      args.place.admin1,
      args.place.lat,
      args.place.lng,
      args.now,
      args.expiresAt,
      args.now,
      args.now,
    )
    .run();
}

export async function listBatchesForOwner(env: Env, ownerId: string): Promise<BatchRow[]> {
  const { results } = await env.DB.prepare(`SELECT ${BATCH_COLUMNS} FROM upload_batches WHERE owner_id = ? ORDER BY updated_at DESC`)
    .bind(ownerId)
    .all<BatchRow>();
  return results;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export async function loadItemsForBatch(env: Env, batchId: string): Promise<BatchItemRow[]> {
  const { results } = await env.DB.prepare(`SELECT ${ITEM_COLUMNS} FROM upload_batch_items WHERE batch_id = ? ORDER BY created_at, id`)
    .bind(batchId)
    .all<BatchItemRow>();
  return results;
}

export async function findItemByClientId(env: Env, batchId: string, clientItemId: string): Promise<BatchItemRow | null> {
  const row = await env.DB.prepare(`SELECT ${ITEM_COLUMNS} FROM upload_batch_items WHERE batch_id = ? AND client_item_id = ?`)
    .bind(batchId, clientItemId)
    .first<BatchItemRow>();
  return row ?? null;
}

export async function findItemById(env: Env, itemId: string): Promise<BatchItemRow | null> {
  const row = await env.DB.prepare(`SELECT ${ITEM_COLUMNS} FROM upload_batch_items WHERE id = ?`).bind(itemId).first<BatchItemRow>();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

/**
 * Every *finished* upload in this batch, in display order. `photo_id IS NOT
 * NULL` excludes reservations still in flight — a mapping row reserved
 * before its debit and its bytes exist (see `routes/bulk.ts`) is a draft
 * workspace fact nobody outside that one PUT handler should see yet; it must
 * not inflate `photo_count` or appear in `BatchDetail.photos` with a
 * `photo_id` the response schema requires to be a real id.
 */
export async function loadPhotosForBatch(env: Env, batchId: string): Promise<ResolvedBatchPhotoRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${PHOTO_COLUMNS} FROM upload_batch_photos WHERE batch_id = ? AND photo_id IS NOT NULL ORDER BY position, id`,
  )
    .bind(batchId)
    .all<ResolvedBatchPhotoRow>();
  return results;
}

/** Looks up a batch's photo mapping by client key regardless of whether the
 * upload it names has finished storing — unlike {@link loadPhotosForBatch},
 * this is also how `routes/bulk.ts`'s PUT handler finds an unresolved
 * reservation (`photo_id IS NULL`) to resume without a second debit. */
export async function findBatchPhotoByClientId(env: Env, batchId: string, clientPhotoId: string): Promise<BatchPhotoRow | null> {
  const row = await env.DB.prepare(`SELECT ${PHOTO_COLUMNS} FROM upload_batch_photos WHERE batch_id = ? AND client_photo_id = ?`)
    .bind(batchId, clientPhotoId)
    .first<BatchPhotoRow>();
  return row ?? null;
}

/**
 * Wholesale re-pointing for one item's `photo_client_ids`: detach anything
 * this item currently holds that isn't in the new list, then (re)attach the
 * new list in order. Same detach-then-reattach shape as `PATCH
 * /api/listings/:id`'s `photo_ids` handling in `routes/listings.ts`, for the
 * same reason — "group these three into one item" and "split that group"
 * are both just a new list, and neither needs a merge against whatever the
 * item held a moment ago.
 *
 * Returns statements rather than running them, so a caller can fold this
 * into the same `env.DB.batch()` as the item's own insert/update.
 */
export function buildPhotoRepointStatements(env: Env, batchId: string, itemId: string, clientPhotoIds: string[]): D1PreparedStatement[] {
  if (clientPhotoIds.length === 0) {
    return [env.DB.prepare(`UPDATE upload_batch_photos SET item_id = NULL, position = 0 WHERE item_id = ?`).bind(itemId)];
  }

  const placeholders = clientPhotoIds.map(() => "?").join(",");
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`UPDATE upload_batch_photos SET item_id = NULL WHERE item_id = ? AND client_photo_id NOT IN (${placeholders})`).bind(
      itemId,
      ...clientPhotoIds,
    ),
  ];
  clientPhotoIds.forEach((clientPhotoId, position) => {
    statements.push(
      env.DB.prepare(`UPDATE upload_batch_photos SET item_id = ?, position = ? WHERE batch_id = ? AND client_photo_id = ?`).bind(
        itemId,
        position,
        batchId,
        clientPhotoId,
      ),
    );
  });
  return statements;
}

// ---------------------------------------------------------------------------
// The one rule this module exists to keep: never restate a publishing rule.
// ---------------------------------------------------------------------------

/**
 * The first zod issue, in the giver's language. `CreateListingInput`'s own
 * messages are either generic zod defaults ("String must contain at least
 * 20 character(s)") or written for a form that already labels each field —
 * neither is right read cold in a batch summary line, so this maps the
 * *field name* zod rejected to a sentence. It never invents a bound: a
 * story's minimum length is still `STORY_MIN`, imported, not retyped.
 */
function firstIssueSentence(error: z.ZodError): string {
  const issue = error.issues[0];
  const field = issue?.path[0];
  switch (field) {
    case "title":
      return "Give this item a title.";
    case "story":
      return `Add a bit more of its story — at least ${STORY_MIN} characters.`;
    case "category":
      return "Choose a category for this item.";
    case "photo_ids":
      return "Add at least one photo.";
    case "aspects":
      return "One of this item's details isn't valid — check its name and value.";
    case "country":
    case "postal_code":
      return "This batch needs a postcode we recognize before this item can publish.";
    default:
      return "This item needs a few more details before it can be published.";
  }
}

/** Runs the real `CreateListingInput` over one assembled draft item.
 * `date_of_birth` is a fixed stand-in — issue #64's actual attestation
 * happens once, at submission, over the whole selection
 * (`SubmitBatchInput.date_of_birth`), never here; this call only asks
 * whether the schema's *shape* rules (title, story, category, photo count,
 * aspects) are satisfied yet. */
function checkItemReadiness(
  batch: BatchRow,
  item: BatchItemRow,
  photoIds: string[],
): { ready: boolean; blocked_reason: string | null } {
  const aspects: unknown = item.aspects_json ? JSON.parse(item.aspects_json) : [];
  const candidate = {
    title: item.title ?? "",
    story: item.story ?? "",
    category: (item.category ?? "") as Category,
    country: batch.country as Country,
    postal_code: batch.postal_code,
    photo_ids: photoIds,
    date_of_birth: "1990-01-01" as const,
    aspects,
  };
  const parsed = CreateListingInput.safeParse(candidate);
  if (parsed.success) return { ready: true, blocked_reason: null };
  return { ready: false, blocked_reason: firstIssueSentence(parsed.error) };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function parseAspects(aspectsJson: string | null): BatchItemSummary["aspects"] {
  if (!aspectsJson) return [];
  return JSON.parse(aspectsJson) as BatchItemSummary["aspects"];
}

function buildItemSummary(batch: BatchRow, item: BatchItemRow, itemPhotos: ResolvedBatchPhotoRow[]): BatchItemSummary {
  const photoIds = itemPhotos.map((photo) => photo.photo_id);
  const { ready, blocked_reason } = checkItemReadiness(batch, item, photoIds);
  return {
    id: item.id,
    client_item_id: item.client_item_id,
    title: item.title,
    story: item.story,
    category: (item.category as Category | null) ?? null,
    room_label: item.room_label,
    lot_label: item.lot_label,
    aspects: parseAspects(item.aspects_json),
    photo_client_ids: itemPhotos.map((photo) => photo.client_photo_id),
    state: item.state as BatchItemState,
    revision: item.revision,
    listing_id: item.listing_id,
    ready,
    blocked_reason,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

function buildPhotoSummary(photo: ResolvedBatchPhotoRow, itemClientIdById: Map<string, string>): BatchPhotoSummary {
  return {
    client_photo_id: photo.client_photo_id,
    photo_id: photo.photo_id,
    item_client_id: photo.item_id ? itemClientIdById.get(photo.item_id) ?? null : null,
    position: photo.position,
    url_thumb: `/i/${photo.photo_id}/thumb`,
  };
}

function buildBatchDetail(batch: BatchRow, items: BatchItemSummary[], photos: BatchPhotoSummary[]): BatchDetail {
  return {
    id: batch.id,
    client_batch_key: batch.client_batch_key,
    name: batch.name,
    country: batch.country as Country,
    postal_code: batch.postal_code,
    place_name: batch.place_name,
    admin1: batch.admin1,
    shared_story: batch.shared_story,
    state: batch.state as BatchState,
    revision: batch.revision,
    item_count: items.length,
    ready_count: items.filter((item) => item.ready).length,
    photo_count: photos.length,
    created_at: batch.created_at,
    updated_at: batch.updated_at,
    expires_at: batch.expires_at,
    items,
    photos,
  };
}

/** Strips `items`/`photos` off a `BatchDetail` — every field `BatchSummary`
 * needs was already computed building the detail, so this is a pure
 * narrowing, not a second pass over the rows. */
export function toBatchSummary(detail: BatchDetail): BatchSummary {
  const { items, photos, ...summary } = detail;
  return summary;
}

/**
 * The one assembly point: two child queries (`loadItemsForBatch`,
 * `loadPhotosForBatch`), grouped in memory, never one query per item or
 * photo. Returns `null` when the batch doesn't exist *for this owner* —
 * {@link findBatchById} is where that guard actually lives.
 */
export async function loadBatchDetail(env: Env, batchId: string, ownerId: string): Promise<BatchDetail | null> {
  const batch = await findBatchById(env, batchId, ownerId);
  if (!batch) return null;
  return assembleBatchDetail(env, batch);
}

/** Split out from {@link loadBatchDetail} so a caller that already holds the
 * `BatchRow` from its own write (e.g. after an `UPDATE ... WHERE revision =
 * ?` succeeded) doesn't pay for a third lookup of the same row. */
export async function assembleBatchDetail(env: Env, batch: BatchRow): Promise<BatchDetail> {
  const [itemRows, photoRows] = await Promise.all([loadItemsForBatch(env, batch.id), loadPhotosForBatch(env, batch.id)]);

  const itemClientIdById = new Map(itemRows.map((item) => [item.id, item.client_item_id]));
  const photosByItem = new Map<string, ResolvedBatchPhotoRow[]>();
  for (const photo of photoRows) {
    if (!photo.item_id) continue;
    const existing = photosByItem.get(photo.item_id);
    if (existing) existing.push(photo);
    else photosByItem.set(photo.item_id, [photo]);
  }

  const items = itemRows.map((item) => buildItemSummary(batch, item, photosByItem.get(item.id) ?? []));
  const photos = photoRows.map((photo) => buildPhotoSummary(photo, itemClientIdById));
  return buildBatchDetail(batch, items, photos);
}

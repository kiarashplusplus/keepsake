/**
 * Estate bulk uploads (`migrations/20260908043946_bulk_upload.sql`) leave
 * every photo in a batch with `listing_id IS NULL` for as long as the giver
 * is still preparing it, which can be days — the same shape
 * `orphanSweep.ts`'s `sweepOrphanPhotos` otherwise treats as an abandoned
 * `give` flow and deletes after 24 hours. `photos.retain_until` is the
 * column that tells the two apart, and this file is the guard for it.
 *
 * Two things every case here has to get right, the same way
 * `orphanSweep.test.ts` already does for the backup guard (#178):
 *
 *  - A photo that "survives" has to be backed up first. Otherwise it would
 *    survive anyway, deferred by `isBackedUp`, and the test would pass
 *    whether or not `retain_until` did anything at all.
 *  - A photo that "is deleted" has to be checked for real: the D1 row gone
 *    *and* both R2 objects gone, not merely absent from one side.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { orphanSweep } from "../src/cron/orphanSweep.js";
import { ulid } from "../src/lib/ids.js";
import { insertOwner } from "./helpers.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Same stand-in as `orphanSweep.test.ts` uses for
 * `.github/workflows/backup-photos.yml` having already run — see that
 * file's comment on `markBackedUp` for why every deletion case has to call
 * this explicitly rather than relying on a default. */
async function markBackedUp(...keys: string[]): Promise<void> {
  const backup = (env as unknown as { PHOTO_BACKUP_BUCKET: R2Bucket }).PHOTO_BACKUP_BUCKET;
  for (const key of keys) {
    await backup.put(key, new Uint8Array([9]));
  }
}

async function photoRowExists(id: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT id FROM photos WHERE id = ?").bind(id).first<{ id: string }>();
  return row !== null;
}

async function r2ObjectExists(key: string): Promise<boolean> {
  const object = await env.BUCKET.head(key);
  return object !== null;
}

async function retainUntilOf(id: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT retain_until FROM photos WHERE id = ?")
    .bind(id)
    .first<{ retain_until: number | null }>();
  return row?.retain_until ?? null;
}

interface InsertBatchPhotoOptions {
  createdAt: number;
  retainUntil?: number | null;
  /** Default true, same default as `orphanSweep.test.ts`'s
   * `insertOrphanPhoto`: the nightly backup has already copied this photo. */
  backedUp?: boolean;
}

/** Inserts a `photos` row exactly the way `photos/store.ts` would for a bulk
 * upload — including `retain_until` — and links it into a batch's photo
 * tray via `upload_batch_photos`, the same join `sweepExpiredBatches` reads
 * to find which photos belong to an expiring batch. */
async function insertBatchPhoto(
  batchId: string,
  ownerId: string,
  options: InsertBatchPhotoOptions,
): Promise<{ id: string; fullKey: string; thumbKey: string }> {
  const id = ulid();
  const fullKey = `photos/${id}/full.jpg`;
  const thumbKey = `photos/${id}/thumb.jpg`;

  await env.BUCKET.put(fullKey, new Uint8Array([1, 2, 3]));
  await env.BUCKET.put(thumbKey, new Uint8Array([4, 5, 6]));

  await env.DB.prepare(
    `INSERT INTO photos (id, owner_id, listing_id, position, r2_key_full, r2_key_thumb, width, height, bytes_full, blurhash, content_type, moderation_status, created_at, retain_until)
     VALUES (?, ?, NULL, NULL, ?, ?, 800, 600, 3, 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 'image/jpeg', 'unchecked', ?, ?)`,
  )
    .bind(id, ownerId, fullKey, thumbKey, options.createdAt, options.retainUntil ?? null)
    .run();

  if (options.backedUp !== false) await markBackedUp(fullKey, thumbKey);

  const batchPhotoId = ulid();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO upload_batch_photos (id, batch_id, client_photo_id, photo_id, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(batchPhotoId, batchId, `client-${id}`, id, now, now)
    .run();

  return { id, fullKey, thumbKey };
}

interface InsertBatchOptions {
  ownerId: string;
  state: string;
  expiresAt: number;
}

/** Inserts an `upload_batches` row directly, the way `insertOwner` and
 * `insertApprovedListing` in `helpers.ts` bypass the real route for their
 * own tables. */
async function insertBatch(options: InsertBatchOptions): Promise<string> {
  const id = ulid();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO upload_batches
      (id, owner_id, client_batch_key, name, country, postal_code, place_name, lat, lng, state, last_activity_at, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'Test estate', 'US', '94103', 'San Francisco', 37.7749, -122.4194, ?, ?, ?, ?, ?)`,
  )
    .bind(id, options.ownerId, `client-${id}`, options.state, now, options.expiresAt, now, now)
    .run();
  return id;
}

async function batchRow(id: string): Promise<{ state: string; cancelled_at: number | null } | null> {
  return env.DB.prepare("SELECT state, cancelled_at FROM upload_batches WHERE id = ?")
    .bind(id)
    .first<{ state: string; cancelled_at: number | null }>();
}

describe("orphanSweep: bulk-upload draft photos keep their retention (#retain_until)", () => {
  it("a photo older than 24h with retain_until in the future survives the sweep", async () => {
    const ownerId = await insertOwner();
    const batchId = await insertBatch({ ownerId, state: "draft", expiresAt: Date.now() + 7 * DAY_MS });
    const photo = await insertBatchPhoto(batchId, ownerId, {
      createdAt: Date.now() - DAY_MS - HOUR_MS,
      retainUntil: Date.now() + DAY_MS,
      // Backed up on purpose: if this survived only because the backup
      // guard deferred it, the assertion below would pass whether or not
      // retain_until did anything.
      backedUp: true,
    });

    await orphanSweep(env);

    expect(await photoRowExists(photo.id)).toBe(true);
    expect(await r2ObjectExists(photo.fullKey)).toBe(true);
    expect(await r2ObjectExists(photo.thumbKey)).toBe(true);
  });

  it("a photo older than 24h with retain_until in the past is deleted, row and both R2 objects", async () => {
    const ownerId = await insertOwner();
    const batchId = await insertBatch({ ownerId, state: "draft", expiresAt: Date.now() + 7 * DAY_MS });
    const photo = await insertBatchPhoto(batchId, ownerId, {
      createdAt: Date.now() - DAY_MS - HOUR_MS,
      retainUntil: Date.now() - HOUR_MS,
      backedUp: true,
    });

    await orphanSweep(env);

    expect(await photoRowExists(photo.id)).toBe(false);
    expect(await r2ObjectExists(photo.fullKey)).toBe(false);
    expect(await r2ObjectExists(photo.thumbKey)).toBe(false);
  });

  it("a photo older than 24h with retain_until IS NULL is deleted exactly as before", async () => {
    // The control: proves the added predicate did not change ordinary
    // orphan-photo behaviour for a photo that never carried a promise.
    const ownerId = await insertOwner();
    const batchId = await insertBatch({ ownerId, state: "draft", expiresAt: Date.now() + 7 * DAY_MS });
    const photo = await insertBatchPhoto(batchId, ownerId, {
      createdAt: Date.now() - DAY_MS - HOUR_MS,
      retainUntil: null,
      backedUp: true,
    });

    await orphanSweep(env);

    expect(await photoRowExists(photo.id)).toBe(false);
    expect(await r2ObjectExists(photo.fullKey)).toBe(false);
    expect(await r2ObjectExists(photo.thumbKey)).toBe(false);
  });

  it("expires a batch past its own deadline, clears its photos' retain_until, and a later sweep collects them", async () => {
    const ownerId = await insertOwner();
    const batchId = await insertBatch({ ownerId, state: "draft", expiresAt: Date.now() - 60_000 });
    // Recent on purpose: young enough that sweepOrphanPhotos would leave it
    // alone even once retain_until is cleared, so the two effects of this
    // run — the batch expiring, and the photo staying — are both visible.
    const photo = await insertBatchPhoto(batchId, ownerId, {
      createdAt: Date.now() - HOUR_MS,
      retainUntil: Date.now() + DAY_MS,
      backedUp: true,
    });

    await orphanSweep(env);

    const batch = await batchRow(batchId);
    expect(batch?.state).toBe("cancelled");
    expect(batch?.cancelled_at).not.toBeNull();
    expect(await retainUntilOf(photo.id)).toBeNull();
    // Cleared, not deleted: the photo is now an ordinary orphan, but it is
    // not yet 24h old, so this run's sweepOrphanPhotos must not have touched
    // it. Reclamation is the *next* sweep's job, once age catches up.
    expect(await photoRowExists(photo.id)).toBe(true);
    expect(await r2ObjectExists(photo.fullKey)).toBe(true);

    // Age it past the 24h line the way a later night would, and sweep again.
    await env.DB.prepare("UPDATE photos SET created_at = ? WHERE id = ?")
      .bind(Date.now() - DAY_MS - HOUR_MS, photo.id)
      .run();

    await orphanSweep(env);

    expect(await photoRowExists(photo.id)).toBe(false);
    expect(await r2ObjectExists(photo.fullKey)).toBe(false);
    expect(await r2ObjectExists(photo.thumbKey)).toBe(false);
  });

  it("leaves a batch that has not expired untouched, and its photos keep their retention", async () => {
    const ownerId = await insertOwner();
    const batchId = await insertBatch({ ownerId, state: "draft", expiresAt: Date.now() + 7 * DAY_MS });
    const retainUntil = Date.now() + DAY_MS;
    const photo = await insertBatchPhoto(batchId, ownerId, {
      createdAt: Date.now() - DAY_MS - HOUR_MS,
      retainUntil,
      backedUp: true,
    });

    await orphanSweep(env);

    const batch = await batchRow(batchId);
    expect(batch?.state).toBe("draft");
    expect(batch?.cancelled_at).toBeNull();
    expect(await retainUntilOf(photo.id)).toBe(retainUntil);
    expect(await photoRowExists(photo.id)).toBe(true);
    expect(await r2ObjectExists(photo.fullKey)).toBe(true);
  });

  it("never expires a closed batch, however long past its deadline", async () => {
    // A closed batch has already become real listings; its photos were
    // claimed off retain_until the moment listings/create.ts attached them.
    // This is the control that the expiry step selects on state, not just
    // on age — the same shape orphanSweep.test.ts uses for `given` listings.
    const ownerId = await insertOwner();
    const batchId = await insertBatch({ ownerId, state: "closed", expiresAt: Date.now() - 30 * DAY_MS });

    await orphanSweep(env);

    const batch = await batchRow(batchId);
    expect(batch?.state).toBe("closed");
    expect(batch?.cancelled_at).toBeNull();
  });
});

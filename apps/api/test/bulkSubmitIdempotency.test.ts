/**
 * The important properties of the durable runner in `src/bulk/submit.ts`:
 * two overlapping calls to `runBulkOperation` on the same operation create
 * exactly one listing per item, resuming after a simulated crash does too,
 * and a photo that is no longer eligible (already attached elsewhere) fails
 * only the item that wanted it — never silently attaches to two listings.
 *
 * (c) below is deliberately NOT constructed via two `upload_batch_photos`
 * rows sharing one `photo_id` — the migration's own
 * `upload_batch_photos_photo` unique index makes that impossible by design
 * ("a photo belongs to at most one draft, anywhere ... no submission race
 * can attach one photo to two listings"). Instead it simulates the state a
 * successful race would leave behind — a legitimately-owned photo that is
 * no longer unattached by the time the runner reaches it — which exercises
 * the exact same guard in `listings/create.ts`'s guarded INSERT.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SubmitBatchInput } from "@keepsake/contracts/bulk";
import { startSubmission, runBulkOperation, ITEMS_PER_INVOCATION } from "../src/bulk/submit.js";
import { ulid } from "../src/lib/ids.js";
import { insertOwner } from "./helpers.js";

async function insertBatch(ownerId: string): Promise<string> {
  const id = ulid();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO upload_batches
       (id, owner_id, client_batch_key, name, shared_story, country, postal_code, place_name, admin1, lat, lng,
        state, revision, last_activity_at, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'Test batch', NULL, 'US', '02144', 'Somerville', 'MA', 42.3958, -71.0967,
             'draft', 1, ?, ?, ?, ?)`,
  )
    .bind(id, ownerId, `client-${id}`, now, now + 7 * 24 * 60 * 60 * 1000, now, now)
    .run();
  return id;
}

async function insertItem(batchId: string, clientItemId: string): Promise<{ id: string; revision: number }> {
  const id = ulid();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO upload_batch_items
       (id, batch_id, client_item_id, title, story, category, aspects_json, room_label, lot_label, state, revision, created_at, updated_at)
     VALUES (?, ?, ?, 'A lovely teacup', 'This belonged to my grandmother and I would love for it to find a new home.',
             'home_kitchen', NULL, NULL, NULL, 'ready', 1, ?, ?)`,
  )
    .bind(id, batchId, clientItemId, now, now)
    .run();
  return { id, revision: 1 };
}

/** A real object at both R2 keys — see `bulkSubmit.test.ts`'s copy of this
 * helper for why presence (not content) is what `moderatePhotoVariant`
 * needs. */
async function insertPhoto(ownerId: string): Promise<string> {
  const id = ulid();
  const now = Date.now();
  const fullKey = `photos/${id}/full.jpg`;
  const thumbKey = `photos/${id}/thumb.jpg`;
  await env.BUCKET.put(fullKey, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
  await env.BUCKET.put(thumbKey, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
  await env.DB.prepare(
    `INSERT INTO photos
       (id, owner_id, listing_id, position, r2_key_full, r2_key_thumb, width, height, bytes_full, blurhash, content_type, moderation_status, created_at)
     VALUES (?, ?, NULL, NULL, ?, ?, 800, 600, 12345, 'LEHV6nl01waF5-KStrzX', 'image/jpeg', 'unchecked', ?)`,
  )
    .bind(id, ownerId, fullKey, thumbKey, now)
    .run();
  return id;
}

async function attachPhoto(batchId: string, itemId: string, photoId: string, clientPhotoId: string): Promise<void> {
  const id = ulid();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO upload_batch_photos (id, batch_id, client_photo_id, photo_id, item_id, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(id, batchId, clientPhotoId, photoId, itemId, now, now)
    .run();
}

function validDateOfBirth(): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 30);
  return date.toISOString().slice(0, 10);
}

function submitInput(opKey: string, items: { client_item_id: string; revision: number }[]): SubmitBatchInput {
  return { op_key: opKey, date_of_birth: validDateOfBirth(), items };
}

/** A ready item with its own dedicated, unattached photo. */
async function readyItem(ownerId: string, batchId: string, clientItemId: string): Promise<{ id: string; revision: number }> {
  const item = await insertItem(batchId, clientItemId);
  await attachPhoto(batchId, item.id, await insertPhoto(ownerId), `${clientItemId}-photo`);
  return item;
}

async function listingCountFor(itemIds: string[]): Promise<number> {
  const placeholders = itemIds.map(() => "?").join(",");
  const row = await env.DB.prepare(
    `SELECT COUNT(DISTINCT listing_id) AS n FROM upload_batch_items WHERE id IN (${placeholders}) AND listing_id IS NOT NULL`,
  )
    .bind(...itemIds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("bulk submission idempotency", () => {
  it("(a) two concurrent runs of the same operation create exactly one listing per item", async () => {
    const ownerId = await insertOwner();
    const batchId = await insertBatch(ownerId);
    const items = await Promise.all(
      ["concurrent-1", "concurrent-2", "concurrent-3"].map((clientId) => readyItem(ownerId, batchId, clientId)),
    );

    const started = await startSubmission(env, {
      ownerId,
      batchId,
      input: submitInput("concurrent-op", items.map((item, i) => ({ client_item_id: `concurrent-${i + 1}`, revision: item.revision }))),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    // Two genuinely overlapping calls on the *same* operation id — the
    // guarded claim UPDATE in `runBulkOperation` is what makes only one of
    // them actually do the work, and `createListingForOwner`'s own claim is
    // the second line of defense per item.
    await Promise.all([runBulkOperation(env, started.operation.id), runBulkOperation(env, started.operation.id)]);

    // A third call in case the two raced such that neither finished the
    // whole selection (one held the lease while the other found nothing to
    // claim and returned immediately) — `runBulkOperation` is safe to call
    // again, and the loop here is just "keep going until it says done"
    // rather than a fixed count of calls.
    for (let i = 0; i < 5; i++) {
      const op = await env.DB.prepare("SELECT status FROM bulk_operations WHERE id = ?")
        .bind(started.operation.id)
        .first<{ status: string }>();
      if (op?.status === "done") break;
      await runBulkOperation(env, started.operation.id);
    }

    const op = await env.DB.prepare("SELECT status, succeeded, failed FROM bulk_operations WHERE id = ?")
      .bind(started.operation.id)
      .first<{ status: string; succeeded: number; failed: number }>();
    expect(op?.status).toBe("done");
    expect(op?.succeeded).toBe(3);
    expect(op?.failed).toBe(0);

    const itemIds = items.map((item) => item.id);
    expect(await listingCountFor(itemIds)).toBe(3);

    const listingsRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM listings WHERE id IN (SELECT listing_id FROM upload_batch_items WHERE id IN (${itemIds
        .map(() => "?")
        .join(",")}))`,
    )
      .bind(...itemIds)
      .first<{ n: number }>();
    expect(listingsRow?.n).toBe(3);
  });

  it("(b) resuming after a simulated crash still creates exactly one listing per item", async () => {
    const ownerId = await insertOwner();
    const batchId = await insertBatch(ownerId);
    // More than `ITEMS_PER_INVOCATION` so a single call cannot finish the
    // whole selection — the checkpoint after the first call is real
    // progress, not an artifact of everything fitting in one pass.
    const clientIds = Array.from({ length: ITEMS_PER_INVOCATION + 1 }, (_, i) => `crash-${i + 1}`);
    const items = await Promise.all(clientIds.map((clientId) => readyItem(ownerId, batchId, clientId)));

    const started = await startSubmission(env, {
      ownerId,
      batchId,
      input: submitInput(
        "crash-op",
        items.map((item, i) => ({ client_item_id: clientIds[i]!, revision: item.revision })),
      ),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    // First pass: processes `ITEMS_PER_INVOCATION` items, checkpoints, and
    // releases the lease because there's one item left.
    await runBulkOperation(env, started.operation.id);
    const afterFirstPass = await env.DB.prepare("SELECT cursor, status FROM bulk_operations WHERE id = ?")
      .bind(started.operation.id)
      .first<{ cursor: number; status: string }>();
    expect(afterFirstPass?.cursor).toBe(ITEMS_PER_INVOCATION);
    expect(afterFirstPass?.status).toBe("queued");

    // Simulate a crash mid-resume: the lease is stale and the cursor is
    // rewound, as if the checkpoint writes from a previous attempt never
    // happened. Re-running must not create a second listing for any of the
    // `ITEMS_PER_INVOCATION` items already published — `createListingForOwner`'s
    // own claim (`listing_id IS NULL`) is what refuses the second attempt at
    // each of them.
    await env.DB.prepare("UPDATE bulk_operations SET lease_until = ?, cursor = 0 WHERE id = ?")
      .bind(Date.now() - 60_000, started.operation.id)
      .run();

    // Drive it to completion. The rewound items get reprocessed (and safely
    // decline — see this file's header), and the one genuinely-unprocessed
    // item at the end still gets its turn.
    for (let i = 0; i < 5; i++) {
      const op = await env.DB.prepare("SELECT status FROM bulk_operations WHERE id = ?")
        .bind(started.operation.id)
        .first<{ status: string }>();
      if (op?.status === "done") break;
      await runBulkOperation(env, started.operation.id);
    }

    const finalOp = await env.DB.prepare("SELECT status FROM bulk_operations WHERE id = ?")
      .bind(started.operation.id)
      .first<{ status: string }>();
    expect(finalOp?.status).toBe("done");

    const itemIds = items.map((item) => item.id);
    // The property under test: however many times any given item was
    // reprocessed, it ends up with exactly one listing — never zero (it was
    // a ready item with a real photo) and never two.
    expect(await listingCountFor(itemIds)).toBe(itemIds.length);
    for (const itemId of itemIds) {
      const row = await env.DB.prepare("SELECT listing_id FROM upload_batch_items WHERE id = ?")
        .bind(itemId)
        .first<{ listing_id: string | null }>();
      expect(row?.listing_id).not.toBeNull();
    }
  });

  it("(c) when an item's photo is no longer eligible, only that item fails with photo_conflict", async () => {
    const ownerId = await insertOwner();
    const batchId = await insertBatch(ownerId);

    const clean = await readyItem(ownerId, batchId, "clean-item");
    const contested = await readyItem(ownerId, batchId, "contested-item");

    // Simulate the outcome a genuine race would leave behind: the
    // `contested-item`'s own photo has, by the time the runner reaches it,
    // already been attached to some other listing — same effect as another
    // process winning a race for it, without needing two
    // `upload_batch_photos` rows to point at one `photo_id` (which the
    // schema's own unique index refuses).
    const contestedPhoto = await env.DB.prepare(
      "SELECT photo_id FROM upload_batch_photos WHERE item_id = ?",
    )
      .bind(contested.id)
      .first<{ photo_id: string }>();
    const otherListingId = ulid();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO listings
         (id, owner_id, title, story, category, country, postal_code, place_name, admin1, lat, lng,
          status, version, created_at, updated_at)
       VALUES (?, ?, 'Unrelated listing', 'Already published, already holding this photo, nothing to do with this batch.',
               'home_kitchen', 'US', '02144', 'Somerville', 'MA', 42.3958, -71.0967, 'pending', 1, ?, ?)`,
    )
      .bind(otherListingId, ownerId, now, now)
      .run();
    await env.DB.prepare("UPDATE photos SET listing_id = ? WHERE id = ?").bind(otherListingId, contestedPhoto?.photo_id).run();

    const started = await startSubmission(env, {
      ownerId,
      batchId,
      input: submitInput("photo-conflict-op", [
        { client_item_id: "clean-item", revision: clean.revision },
        { client_item_id: "contested-item", revision: contested.revision },
      ]),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await runBulkOperation(env, started.operation.id);

    const op = await env.DB.prepare("SELECT status, succeeded, failed FROM bulk_operations WHERE id = ?")
      .bind(started.operation.id)
      .first<{ status: string; succeeded: number; failed: number }>();
    expect(op?.status).toBe("done");
    expect(op?.succeeded).toBe(1);
    expect(op?.failed).toBe(1);

    const cleanRow = await env.DB.prepare("SELECT state, listing_id FROM upload_batch_items WHERE id = ?")
      .bind(clean.id)
      .first<{ state: string; listing_id: string | null }>();
    expect(cleanRow?.state).toBe("submitted");
    expect(cleanRow?.listing_id).not.toBeNull();

    const contestedRow = await env.DB.prepare(
      "SELECT state, listing_id, failure_code FROM upload_batch_items WHERE id = ?",
    )
      .bind(contested.id)
      .first<{ state: string; listing_id: string | null; failure_code: string | null }>();
    expect(contestedRow?.state).toBe("failed");
    expect(contestedRow?.listing_id).toBeNull();
    expect(contestedRow?.failure_code).toBe("photo_conflict");

    // Exactly one *new* listing was created between the two items — the
    // clean one's. The contested photo's listing is the pre-existing,
    // unrelated one, not a duplicate of anything this operation made.
    expect(await listingCountFor([clean.id, contested.id])).toBe(1);
  });
});

/**
 * End-to-end coverage of the durable submission runner
 * (`src/bulk/submit.ts`): a batch with three ready items and one incomplete
 * one is submitted, driven to completion, and the three ready items become
 * ordinary listings while the incomplete one fails on its own — without
 * that one bad item discarding the three good ones. Calls `startSubmission`
 * and `runBulkOperation` directly rather than through `routes/bulk.ts`
 * (owned by another agent and not yet part of this suite), the same way
 * `test/orphanSweep.test.ts` drives its cron function directly rather than
 * through a route.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SubmitBatchInput } from "@keepsake/contracts/bulk";
import { startSubmission, runBulkOperation } from "../src/bulk/submit.js";
import { ulid } from "../src/lib/ids.js";
import { insertOwner } from "./helpers.js";

async function insertBatch(ownerId: string): Promise<string> {
  const id = ulid();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO upload_batches
       (id, owner_id, client_batch_key, name, shared_story, country, postal_code, place_name, admin1, lat, lng,
        state, revision, last_activity_at, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'Mum''s house', NULL, 'US', '02144', 'Somerville', 'MA', 42.3958, -71.0967,
             'draft', 1, ?, ?, ?, ?)`,
  )
    .bind(id, ownerId, `client-${id}`, now, now + 7 * 24 * 60 * 60 * 1000, now, now)
    .run();
  return id;
}

interface DraftItemFields {
  title?: string | null;
  story?: string | null;
  category?: string | null;
  aspectsJson?: string | null;
}

async function insertItem(batchId: string, clientItemId: string, fields: DraftItemFields = {}): Promise<{ id: string; revision: number }> {
  const id = ulid();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO upload_batch_items
       (id, batch_id, client_item_id, title, story, category, aspects_json, room_label, lot_label, state, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'ready', 1, ?, ?)`,
  )
    .bind(
      id,
      batchId,
      clientItemId,
      fields.title ?? "A lovely teacup",
      fields.story === undefined ? "This belonged to my grandmother and I would love for it to find a new home." : fields.story,
      fields.category === undefined ? "home_kitchen" : fields.category,
      fields.aspectsJson ?? null,
      now,
      now,
    )
    .run();
  return { id, revision: 1 };
}

/** A real object at both R2 keys — `moderatePhotoVariant`
 * (`src/moderation/pipeline.ts`) fetches the bytes before it ever consults
 * `MOCK_AI`, and a missing object is a fail-closed `error` verdict, never a
 * skip. The content doesn't matter under `MOCK_AI=1` (`moderateImage`
 * short-circuits before decoding it); only presence does. */
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

async function attachPhoto(batchId: string, itemId: string, photoId: string, clientPhotoId: string, position = 0): Promise<void> {
  const id = ulid();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO upload_batch_photos (id, batch_id, client_photo_id, photo_id, item_id, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, batchId, clientPhotoId, photoId, itemId, position, now, now)
    .run();
}

/** Satisfies `DateOfBirthSchema` regardless of when the suite happens to
 * run — see `src/bulk/submit.ts`'s `placeholderDateOfBirth` for why the
 * exact value doesn't matter: it's never persisted, only read once for its
 * pass/fail verdict. */
function validDateOfBirth(): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 30);
  return date.toISOString().slice(0, 10);
}

function submitInput(opKey: string, items: { client_item_id: string; revision: number }[]): SubmitBatchInput {
  return { op_key: opKey, date_of_birth: validDateOfBirth(), items };
}

describe("bulk submission: end to end", () => {
  it("publishes the ready items and fails the incomplete one without losing the others", async () => {
    const ownerId = await insertOwner();
    const batchId = await insertBatch(ownerId);

    const ready1 = await insertItem(batchId, "item-1");
    await attachPhoto(batchId, ready1.id, await insertPhoto(ownerId), "photo-1");

    const ready2 = await insertItem(batchId, "item-2");
    await attachPhoto(batchId, ready2.id, await insertPhoto(ownerId), "photo-2");

    const ready3 = await insertItem(batchId, "item-3");
    await attachPhoto(batchId, ready3.id, await insertPhoto(ownerId), "photo-3");

    // Incomplete: no story at all. The publishing rule this item fails is
    // caught entirely by the real `CreateListingInput` — see submit.ts's
    // header on why nothing here restates it.
    const incomplete = await insertItem(batchId, "item-4", { story: null });
    await attachPhoto(batchId, incomplete.id, await insertPhoto(ownerId), "photo-4");

    const started = await startSubmission(env, {
      ownerId,
      batchId,
      input: submitInput("submit-e2e-1", [
        { client_item_id: "item-1", revision: ready1.revision },
        { client_item_id: "item-2", revision: ready2.revision },
        { client_item_id: "item-3", revision: ready3.revision },
        { client_item_id: "item-4", revision: incomplete.revision },
      ]),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.operation.total).toBe(4);
    expect(started.operation.status).toBe("queued");
    expect(started.replayed).toBe(false);

    // Four items, well under `ITEMS_PER_INVOCATION` (5) — one call finishes
    // the whole operation.
    await runBulkOperation(env, started.operation.id);

    const op = await env.DB.prepare("SELECT status, succeeded, failed, finished_at FROM bulk_operations WHERE id = ?")
      .bind(started.operation.id)
      .first<{ status: string; succeeded: number; failed: number; finished_at: number | null }>();
    expect(op?.status).toBe("done");
    expect(op?.succeeded).toBe(3);
    expect(op?.failed).toBe(1);
    expect(op?.finished_at).not.toBeNull();

    for (const item of [ready1, ready2, ready3]) {
      const row = await env.DB.prepare("SELECT state, listing_id FROM upload_batch_items WHERE id = ?")
        .bind(item.id)
        .first<{ state: string; listing_id: string | null }>();
      expect(row?.state).toBe("submitted");
      expect(row?.listing_id).not.toBeNull();

      const listing = await env.DB.prepare("SELECT status, owner_id FROM listings WHERE id = ?")
        .bind(row?.listing_id)
        .first<{ status: string; owner_id: string }>();
      expect(listing?.owner_id).toBe(ownerId);
      // MOCK_AI is on for the whole suite (vitest.config.ts), and
      // `runBulkOperation` awaits `moderateListing` rather than
      // `waitUntil`-ing it — by the time this call returns, moderation has
      // already resolved. No polling needed, unlike the give-flow tests
      // that go through `waitUntil`.
      expect(listing?.status).toBe("approved");
    }

    const failedRow = await env.DB.prepare(
      "SELECT state, listing_id, failure_code, failure_detail FROM upload_batch_items WHERE id = ?",
    )
      .bind(incomplete.id)
      .first<{ state: string; listing_id: string | null; failure_code: string | null; failure_detail: string | null }>();
    expect(failedRow?.state).toBe("failed");
    expect(failedRow?.listing_id).toBeNull();
    // Giver-facing, from the first zod issue — not asserting the exact
    // wording (that's zod's to change), only that *something* legible was
    // recorded rather than nothing.
    expect(failedRow?.failure_detail).toBeTruthy();
    expect(failedRow?.failure_code).toBe("invalid");

    const batch = await env.DB.prepare("SELECT state FROM upload_batches WHERE id = ?").bind(batchId).first<{ state: string }>();
    expect(batch?.state).toBe("closed");
  });

  it("rejects an aspect carrying contact info the same way the give flow does", async () => {
    const ownerId = await insertOwner();
    const batchId = await insertBatch(ownerId);
    const item = await insertItem(batchId, "item-contact", {
      aspectsJson: JSON.stringify([{ name: "contact", value: "call me at 555-123-4567" }]),
    });
    await attachPhoto(batchId, item.id, await insertPhoto(ownerId), "photo-1");

    const started = await startSubmission(env, {
      ownerId,
      batchId,
      input: submitInput("submit-contact-1", [{ client_item_id: "item-contact", revision: item.revision }]),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await runBulkOperation(env, started.operation.id);

    const row = await env.DB.prepare("SELECT state, listing_id, failure_code FROM upload_batch_items WHERE id = ?")
      .bind(item.id)
      .first<{ state: string; listing_id: string | null; failure_code: string | null }>();
    expect(row?.state).toBe("failed");
    expect(row?.listing_id).toBeNull();
    expect(row?.failure_code).toBe("contact_info");
  });
});

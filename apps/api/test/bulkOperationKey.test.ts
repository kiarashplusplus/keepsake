/**
 * `startSubmission`'s idempotency key: `(owner_id, batch_id, kind, op_key)`
 * is the unique index, `payload_hash` is what tells a genuine retry apart
 * from a caller bug reusing the same key for a different selection — see
 * `src/bulk/submit.ts`'s header for why both halves exist.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SubmitBatchInput } from "@keepsake/contracts/bulk";
import { startSubmission } from "../src/bulk/submit.js";
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

function validDateOfBirth(): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 30);
  return date.toISOString().slice(0, 10);
}

function submitInput(opKey: string, items: { client_item_id: string; revision: number }[]): SubmitBatchInput {
  return { op_key: opKey, date_of_birth: validDateOfBirth(), items };
}

async function countOperations(batchId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM bulk_operations WHERE batch_id = ?")
    .bind(batchId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("bulk operation key: op_key + payload_hash", () => {
  it("replays the existing operation when the same op_key arrives with the same selection", async () => {
    const ownerId = await insertOwner();
    const batchId = await insertBatch(ownerId);
    const item1 = await insertItem(batchId, "item-1");
    const item2 = await insertItem(batchId, "item-2");

    const selection = [
      { client_item_id: "item-1", revision: item1.revision },
      { client_item_id: "item-2", revision: item2.revision },
    ];

    const first = await startSubmission(env, { ownerId, batchId, input: submitInput("replay-key", selection) });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.replayed).toBe(false);

    // Same key, same selection — including submitting the array in a
    // different order, which must hash identically (see submit.ts's
    // `canonicalSelection`).
    const second = await startSubmission(env, {
      ownerId,
      batchId,
      input: submitInput("replay-key", [...selection].reverse()),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.replayed).toBe(true);
    expect(second.operation.id).toBe(first.operation.id);

    expect(await countOperations(batchId)).toBe(1);
  });

  it("answers 409 when the same op_key arrives with a changed selection", async () => {
    const ownerId = await insertOwner();
    const batchId = await insertBatch(ownerId);
    const item1 = await insertItem(batchId, "item-1");
    const item2 = await insertItem(batchId, "item-2");
    const item3 = await insertItem(batchId, "item-3");

    const first = await startSubmission(env, {
      ownerId,
      batchId,
      input: submitInput("changed-key", [{ client_item_id: "item-1", revision: item1.revision }]),
    });
    expect(first.ok).toBe(true);

    const second = await startSubmission(env, {
      ownerId,
      batchId,
      input: submitInput("changed-key", [
        { client_item_id: "item-2", revision: item2.revision },
        { client_item_id: "item-3", revision: item3.revision },
      ]),
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("conflict");
    expect(second.status).toBe(409);

    // The caller-bug 409 must not have created a second row under the same
    // key — only the original operation exists.
    expect(await countOperations(batchId)).toBe(1);
  });

  it("answers 409 naming the items that moved since they were reviewed", async () => {
    const ownerId = await insertOwner();
    const batchId = await insertBatch(ownerId);
    const item1 = await insertItem(batchId, "item-1");

    const result = await startSubmission(env, {
      ownerId,
      batchId,
      // Reviewed at revision 1; the row is actually still at revision 1, so
      // asking for revision 2 is exactly "this changed since you looked".
      input: submitInput("stale-revision-key", [{ client_item_id: "item-1", revision: item1.revision + 1 }]),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("conflict");
    expect(result.status).toBe(409);
    expect(result.message).toContain("item-1");

    expect(await countOperations(batchId)).toBe(0);
  });

  it("two different op_keys on the same batch each get their own operation", async () => {
    const ownerId = await insertOwner();
    const batchId = await insertBatch(ownerId);
    const item1 = await insertItem(batchId, "item-1");

    const first = await startSubmission(env, {
      ownerId,
      batchId,
      input: submitInput("key-a", [{ client_item_id: "item-1", revision: item1.revision }]),
    });
    const second = await startSubmission(env, {
      ownerId,
      batchId,
      input: submitInput("key-b", [{ client_item_id: "item-1", revision: item1.revision }]),
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.operation.id).not.toBe(second.operation.id);
    expect(await countOperations(batchId)).toBe(2);
  });
});

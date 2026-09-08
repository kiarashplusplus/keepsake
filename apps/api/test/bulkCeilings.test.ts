/**
 * Estate bulk upload — what bounds a batch now that the admission code is
 * gone.
 *
 * This file replaced `bulkAdmission.test.ts`, which pinned `requireGrant()`:
 * no header 403s, an expired/revoked/foreign grant 403s, a grant's
 * `items_remaining` is exact. There is no grant any more (see
 * `20260908094215_bulk_drop_grants.sql`), so the first test below pins the
 * opposite — an owner token, and nothing else, is enough to write — and the
 * rest pin the two bounds that took the grant's place:
 *
 *   * per batch, `BULK_MAX_ITEMS_PER_BATCH` / `BULK_MAX_PHOTOS_PER_BATCH`,
 *     enforced as a predicate on the insert itself;
 *   * per owner per day, `bulk_owner_usage`, which survives a giver starting
 *     a second batch.
 *
 * Both are exact D1-guarded writes, never KV — the reason the old file gave
 * for the grant's counters applies unchanged to the ones that replaced them.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bulkRoutes } from "../src/routes/bulk.js";
import { ulid } from "../src/lib/ids.js";
import { sha256Hex } from "../src/lib/digest.js";
import { todayISO } from "../src/lib/day.js";
import { authHeaders, fakeFile, fakeJpegBytes, freshOwnerToken, readErr, readOk, seedStandardPostalCodes, setTestEnvVar } from "./helpers.js";

const VALID_STORY = "This belonged to my grandmother, and I would love for it to find a new home.";

async function seedOwner(token: string): Promise<string> {
  const id = ulid();
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  await env.DB.prepare("INSERT INTO owners (id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
    .bind(id, tokenHash, now, now)
    .run();
  return id;
}

function bulkHeaders(token: string): Record<string, string> {
  return { ...authHeaders(token), "Content-Type": "application/json" };
}

async function bulk(path: string, init: RequestInit = {}): Promise<Response> {
  return bulkRoutes.request(path, init, env);
}

function photoForm(): FormData {
  const form = new FormData();
  const bytes = fakeJpegBytes();
  form.set("full", fakeFile(bytes, "full.jpg", "image/jpeg"));
  form.set("thumb", fakeFile(bytes, "thumb.jpg", "image/jpeg"));
  form.set("width", "800");
  form.set("height", "600");
  form.set("blurhash", "LEHV6nWB2yk8pyo0adR*.7kCMdnj");
  return form;
}

async function createBatch(token: string, clientBatchKey: string): Promise<{ id: string }> {
  const res = await bulk("/batches", {
    method: "POST",
    headers: bulkHeaders(token),
    body: JSON.stringify({ client_batch_key: clientBatchKey, name: "Estate", country: "US", postal_code: "02144" }),
  });
  return readOk<{ id: string }>(res);
}

async function putItem(token: string, batchId: string, clientItemId: string, title: string): Promise<Response> {
  return bulk(`/batches/${batchId}/items/${clientItemId}`, {
    method: "PUT",
    headers: bulkHeaders(token),
    body: JSON.stringify({ fields: { title, story: VALID_STORY, category: "other" } }),
  });
}

async function usageRow(ownerId: string): Promise<{ items_used: number; photos_used: number; suggestions_used: number } | null> {
  return env.DB.prepare("SELECT items_used, photos_used, suggestions_used FROM bulk_owner_usage WHERE owner_id = ? AND day = ?")
    .bind(ownerId, todayISO())
    .first<{ items_used: number; photos_used: number; suggestions_used: number }>();
}

describe("estate bulk upload: no admission code", () => {
  it("an owner token alone is enough to start a batch and add to it — no second credential of any kind", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    await seedOwner(token);

    const batch = await createBatch(token, "no-admission-needed");
    const item = await putItem(token, batch.id, "i1", "First");
    expect(item.status).toBe(201);

    const photo = await bulk(`/batches/${batch.id}/photos/p1`, { method: "PUT", headers: authHeaders(token), body: photoForm() });
    expect(photo.status).toBe(201);
  });

  it("a device that has never given anything can start a batch — the owner row is created on sight", async () => {
    await seedStandardPostalCodes();
    // No `seedOwner`: this token has never been seen, which is exactly what
    // a giver landing on `/bulk/new` as their first act on the site looks
    // like. Before the admission code was removed this was unreachable — an
    // operator had already minted a grant against an existing `owners` row —
    // so `POST /batches` carried a plain `ownerAuth()` and would 401 here.
    const token = freshOwnerToken();

    const res = await bulk("/batches", {
      method: "POST",
      headers: bulkHeaders(token),
      body: JSON.stringify({ client_batch_key: "first-ever-request", name: "Estate", country: "US", postal_code: "02144" }),
    });
    expect(res.status).toBe(201);

    const owners = await env.DB.prepare("SELECT COUNT(*) AS n FROM owners WHERE token_hash = ?")
      .bind(await sha256Hex(token))
      .first<{ n: number }>();
    expect(owners?.n).toBe(1);
  });

  it("the bulk_grants table is gone, so nothing can quietly start reading it again", async () => {
    const row = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bulk_grants'").first<{ name: string }>();
    expect(row).toBeNull();
  });
});

describe("estate bulk upload: the per-owner daily ceiling", () => {
  it("the item allowance is exact: a ceiling of 2 lets exactly 2 through and 429s the third, charging nothing for it", async () => {
    await seedStandardPostalCodes();
    setTestEnvVar("BULK_OWNER_DAILY_ITEMS", "2");
    try {
      const token = freshOwnerToken();
      const ownerId = await seedOwner(token);
      const batch = await createBatch(token, "item-ceiling");

      expect((await putItem(token, batch.id, "i1", "First")).status).toBe(201);
      expect((await putItem(token, batch.id, "i2", "Second")).status).toBe(201);

      const third = await putItem(token, batch.id, "i3", "Third");
      expect(third.status).toBe(429);
      const err = await readErr(third);
      expect(err.code).toBe("rate_limited");
      // A daily ceiling resets at UTC midnight, so this one says when to
      // come back — unlike the per-batch cap below, which never does.
      expect(err.retryAfter).toBeDefined();

      // Nothing charged for the refused third item, and it was never created.
      expect((await usageRow(ownerId))?.items_used).toBe(2);
      const itemRow = await env.DB.prepare("SELECT COUNT(*) as n FROM upload_batch_items WHERE batch_id = ? AND client_item_id = 'i3'")
        .bind(batch.id)
        .first<{ n: number }>();
      expect(itemRow?.n ?? 0).toBe(0);
    } finally {
      setTestEnvVar("BULK_OWNER_DAILY_ITEMS", "150");
    }
  });

  it("the photo allowance is exact: a ceiling of 2 lets exactly 2 through and 429s the third", async () => {
    await seedStandardPostalCodes();
    setTestEnvVar("BULK_OWNER_DAILY_PHOTOS", "2");
    try {
      const token = freshOwnerToken();
      const ownerId = await seedOwner(token);
      const batch = await createBatch(token, "photo-ceiling");

      for (const key of ["p1", "p2"]) {
        const res = await bulk(`/batches/${batch.id}/photos/${key}`, { method: "PUT", headers: authHeaders(token), body: photoForm() });
        expect(res.status).toBe(201);
      }

      const third = await bulk(`/batches/${batch.id}/photos/p3`, { method: "PUT", headers: authHeaders(token), body: photoForm() });
      expect(third.status).toBe(429);
      expect((await readErr(third)).code).toBe("rate_limited");

      expect((await usageRow(ownerId))?.photos_used).toBe(2);
      // Fails closed with no durable side effect: no reservation row left
      // behind for the photo that was refused.
      const reserved = await env.DB.prepare("SELECT COUNT(*) as n FROM upload_batch_photos WHERE batch_id = ? AND client_photo_id = 'p3'")
        .bind(batch.id)
        .first<{ n: number }>();
      expect(reserved?.n ?? 0).toBe(0);
    } finally {
      setTestEnvVar("BULK_OWNER_DAILY_PHOTOS", "450");
    }
  });

  it("bites across two different batches — starting another batch does not reset the day", async () => {
    await seedStandardPostalCodes();
    setTestEnvVar("BULK_OWNER_DAILY_PHOTOS", "1");
    try {
      const token = freshOwnerToken();
      const ownerId = await seedOwner(token);
      const batchOne = await createBatch(token, "owner-ceiling-1");
      const batchTwo = await createBatch(token, "owner-ceiling-2");

      const first = await bulk(`/batches/${batchOne.id}/photos/p1`, { method: "PUT", headers: authHeaders(token), body: photoForm() });
      expect(first.status).toBe(201);

      const second = await bulk(`/batches/${batchTwo.id}/photos/p1`, { method: "PUT", headers: authHeaders(token), body: photoForm() });
      expect(second.status).toBe(429);
      const err = await readErr(second);
      expect(err.code).toBe("rate_limited");
      expect(err.retryAfter).toBeDefined();

      expect((await usageRow(ownerId))?.photos_used).toBe(1);
    } finally {
      setTestEnvVar("BULK_OWNER_DAILY_PHOTOS", "450");
    }
  });

  it("a retried upload under the same client key does not spend a second photo", async () => {
    await seedStandardPostalCodes();
    setTestEnvVar("BULK_OWNER_DAILY_PHOTOS", "1");
    try {
      const token = freshOwnerToken();
      const ownerId = await seedOwner(token);
      const batch = await createBatch(token, "retry-allowance");

      const first = await bulk(`/batches/${batch.id}/photos/only`, { method: "PUT", headers: authHeaders(token), body: photoForm() });
      expect(first.status).toBe(201);

      // Exactly one photo of allowance — if the retry spent a second one
      // the counter below would read 2 and a genuinely new photo would
      // have nothing left.
      const retry = await bulk(`/batches/${batch.id}/photos/only`, { method: "PUT", headers: authHeaders(token), body: photoForm() });
      expect(retry.status).toBe(200);
      expect((await usageRow(ownerId))?.photos_used).toBe(1);

      const secondReal = await bulk(`/batches/${batch.id}/photos/second`, { method: "PUT", headers: authHeaders(token), body: photoForm() });
      expect(secondReal.status).toBe(429);
    } finally {
      setTestEnvVar("BULK_OWNER_DAILY_PHOTOS", "450");
    }
  });

  it("re-links a previously stored photo without spending allowance again when the mapping row is missing", async () => {
    await seedStandardPostalCodes();
    setTestEnvVar("BULK_OWNER_DAILY_PHOTOS", "1");
    try {
      const token = freshOwnerToken();
      const ownerId = await seedOwner(token);
      const batch = await createBatch(token, "retry-relink");

      const first = await bulk(`/batches/${batch.id}/photos/only`, { method: "PUT", headers: authHeaders(token), body: photoForm() });
      expect(first.status).toBe(201);
      const firstPhoto = await readOk<{ photo_id: string }>(first);

      await env.DB.prepare("DELETE FROM upload_batch_photos WHERE batch_id = ? AND client_photo_id = ?").bind(batch.id, "only").run();

      const retry = await bulk(`/batches/${batch.id}/photos/only`, { method: "PUT", headers: authHeaders(token), body: photoForm() });
      expect(retry.status).toBe(201);
      expect((await readOk<{ photo_id: string }>(retry)).photo_id).toBe(firstPhoto.photo_id);

      expect((await usageRow(ownerId))?.photos_used).toBe(1);
    } finally {
      setTestEnvVar("BULK_OWNER_DAILY_PHOTOS", "450");
    }
  });
});

describe("estate bulk upload: the per-batch cap", () => {
  it("refuses the item that would overfill a batch, charges nothing for it, and still allows it in a fresh batch", async () => {
    await seedStandardPostalCodes();
    setTestEnvVar("BULK_MAX_ITEMS_PER_BATCH", "2");
    try {
      const token = freshOwnerToken();
      const ownerId = await seedOwner(token);
      const batch = await createBatch(token, "batch-item-cap");

      expect((await putItem(token, batch.id, "i1", "First")).status).toBe(201);
      expect((await putItem(token, batch.id, "i2", "Second")).status).toBe(201);

      const third = await putItem(token, batch.id, "i3", "Third");
      expect(third.status).toBe(429);
      const err = await readErr(third);
      expect(err.message).toContain("full");
      // No `retryAfter`: waiting doesn't empty a batch. The message tells
      // the giver to submit and start another one, and the next assertion
      // is that doing so actually works.
      expect(err.retryAfter).toBeUndefined();

      // The daily counter was refunded — the batch cap refused the write,
      // so it must not have cost the giver a day's allowance.
      expect((await usageRow(ownerId))?.items_used).toBe(2);

      const another = await createBatch(token, "batch-item-cap-2");
      expect((await putItem(token, another.id, "i3", "Third")).status).toBe(201);
      expect((await usageRow(ownerId))?.items_used).toBe(3);
    } finally {
      setTestEnvVar("BULK_MAX_ITEMS_PER_BATCH", "100");
    }
  });

  it("refuses the photo that would overfill a batch, with no reservation and no charge left behind", async () => {
    await seedStandardPostalCodes();
    setTestEnvVar("BULK_MAX_PHOTOS_PER_BATCH", "1");
    try {
      const token = freshOwnerToken();
      const ownerId = await seedOwner(token);
      const batch = await createBatch(token, "batch-photo-cap");

      const first = await bulk(`/batches/${batch.id}/photos/p1`, { method: "PUT", headers: authHeaders(token), body: photoForm() });
      expect(first.status).toBe(201);

      const second = await bulk(`/batches/${batch.id}/photos/p2`, { method: "PUT", headers: authHeaders(token), body: photoForm() });
      expect(second.status).toBe(429);
      expect((await readErr(second)).message).toContain("full");

      expect((await usageRow(ownerId))?.photos_used).toBe(1);
      const reserved = await env.DB.prepare("SELECT COUNT(*) as n FROM upload_batch_photos WHERE batch_id = ?").bind(batch.id).first<{ n: number }>();
      expect(reserved?.n ?? 0).toBe(1);
    } finally {
      setTestEnvVar("BULK_MAX_PHOTOS_PER_BATCH", "300");
    }
  });
});

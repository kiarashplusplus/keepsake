/**
 * The residual bug on `PUT /batches/:id/photos/:clientPhotoId` after PR
 * #257's own follow-up fix (commit c922615): that fix made the photo id
 * deterministic (`reservedPhotoId`, a pure function of
 * `(batchId, clientPhotoId)`) and made `storePhotoUpload` an upsert, which
 * together make a retried *store* safe. They do not make a retried *debit*
 * safe — the handler still checked "does a `photos` row with this id
 * exist?" to decide whether to charge the owner's allowance, and that check
 * cannot tell "never attempted" apart from "debited, then the Worker was
 * evicted before `storePhotoUpload` ever ran". A retry landing in that
 * window debited a second time, and nothing ever refunded it.
 *
 * The fix makes the reservation itself durable proof that the allowance was
 * already spent: a `upload_batch_photos` row is inserted with
 * `photo_id IS NULL`, atomically (one `env.DB.batch()`) with the debit,
 * *before* any R2 byte is written. A retry that finds that row skips the
 * debit and resumes at "store the bytes". See `routes/bulk.ts`'s header on
 * the PUT handler for the full reserve → debit → store → finalize sequence,
 * and the migration's comment on `upload_batch_photos.photo_id` for why the
 * column is nullable at all.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bulkRoutes } from "../src/routes/bulk.js";
import { ulid } from "../src/lib/ids.js";
import { sha256Hex } from "../src/lib/digest.js";
import { todayISO } from "../src/lib/day.js";
import { authHeaders, fakeFile, fakeJpegBytes, freshOwnerToken, readErr, readOk, seedStandardPostalCodes, setTestEnvVar } from "./helpers.js";

async function seedOwner(token: string): Promise<string> {
  const id = ulid();
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  await env.DB.prepare("INSERT INTO owners (id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
    .bind(id, tokenHash, now, now)
    .run();
  return id;
}

/** This owner's `photos_used` for today, or 0 before any row exists. */
async function photosUsed(ownerId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT photos_used FROM bulk_owner_usage WHERE owner_id = ? AND day = ?")
    .bind(ownerId, todayISO())
    .first<{ photos_used: number }>();
  return row?.photos_used ?? 0;
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
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ client_batch_key: clientBatchKey, name: "Estate", country: "US", postal_code: "02144" }),
  });
  return readOk<{ id: string }>(res);
}

async function countPhotosForOwner(ownerId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM photos WHERE owner_id = ?").bind(ownerId).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Mirrors `reservedPhotoId` in `routes/bulk.ts` (not exported) — a pure
 * function of `(batchId, clientPhotoId)`, so a test can predict the id
 * without driving a real upload first. */
async function reservedPhotoId(batchId: string, clientPhotoId: string): Promise<string> {
  const digest = (await sha256Hex(`${batchId}:${clientPhotoId}`)).toUpperCase();
  return `0${digest.slice(0, 25)}`;
}

async function mappingRow(batchId: string, clientPhotoId: string): Promise<{ id: string; photo_id: string | null } | null> {
  return env.DB.prepare("SELECT id, photo_id FROM upload_batch_photos WHERE batch_id = ? AND client_photo_id = ?")
    .bind(batchId, clientPhotoId)
    .first<{ id: string; photo_id: string | null }>();
}

describe("estate bulk upload: photo PUT retry idempotency", () => {
  it("a lost response replayed does not double-debit, create a second photos row, or duplicate R2 objects", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const ownerId = await seedOwner(token);
    const batch = await createBatch(token, "replay-batch");

    const first = await bulk(`/batches/${batch.id}/photos/p1`, {
      method: "PUT",
      headers: authHeaders(token),
      body: photoForm(),
    });
    expect(first.status).toBe(201);
    const firstPhoto = await readOk<{ photo_id: string }>(first);

    // The client never saw the response and retries with the same client key.
    const retry = await bulk(`/batches/${batch.id}/photos/p1`, {
      method: "PUT",
      headers: authHeaders(token),
      body: photoForm(),
    });
    expect(retry.status).toBe(200);
    const retryPhoto = await readOk<{ photo_id: string }>(retry);
    expect(retryPhoto.photo_id).toBe(firstPhoto.photo_id);

    // Charged exactly once for the two requests.
    expect(await photosUsed(ownerId)).toBe(1);

    expect(await countPhotosForOwner(ownerId)).toBe(1);
    const mapping = await env.DB.prepare("SELECT COUNT(*) AS n FROM upload_batch_photos WHERE batch_id = ? AND client_photo_id = ?")
      .bind(batch.id, "p1")
      .first<{ n: number }>();
    expect(mapping?.n).toBe(1);

    const { objects } = await env.BUCKET.list({ prefix: `photos/${firstPhoto.photo_id}/` });
    expect(objects.map((o) => o.key).sort()).toEqual([`photos/${firstPhoto.photo_id}/full.jpg`, `photos/${firstPhoto.photo_id}/thumb.jpg`]);
  });

  it("a retry resumes an interrupted reservation (debited, not yet stored) without a second debit", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const ownerId = await seedOwner(token);
    const batch = await createBatch(token, "resume-batch");

    // Simulate the exact crash window the fix protects: the reservation and
    // its debit landed (one D1 transaction, per the fix), but the Worker was
    // evicted before storing a single byte or finalizing the mapping. This
    // is the state a real interrupted request leaves behind.
    const reservationId = ulid();
    const now = Date.now();
    const day = todayISO();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO upload_batch_photos (id, batch_id, client_photo_id, photo_id, item_id, position, created_at, updated_at)
         VALUES (?, ?, ?, NULL, NULL, 0, ?, ?)`,
      ).bind(reservationId, batch.id, "p1", now, now),
      env.DB.prepare(
        `INSERT INTO bulk_owner_usage (owner_id, day, photos_used) VALUES (?, ?, 1)
           ON CONFLICT(owner_id, day) DO UPDATE SET photos_used = photos_used + 1`,
      ).bind(ownerId, day),
    ]);

    // The daily ceiling stays at its ordinary value, well above what this
    // test spends, so a double charge shows up as an extra increment on
    // `photos_used` rather than being masked by a ceiling that would have
    // refused the second debit anyway.
    const before = await mappingRow(batch.id, "p1");
    expect(before?.photo_id).toBeNull();

    // The retry that actually carries the bytes.
    const res = await bulk(`/batches/${batch.id}/photos/p1`, {
      method: "PUT",
      headers: authHeaders(token),
      body: photoForm(),
    });
    expect(res.status).toBe(201);

    // Not re-debited: the simulated first attempt spent exactly one photo,
    // and this retry must resume rather than spend a second one — this is
    // the assertion the residual bug breaks. A handler that re-checks by
    // asking "does a `photos` row exist yet" cannot tell this state apart
    // from "never attempted" and debits again.
    const usageRow = await env.DB.prepare("SELECT photos_used FROM bulk_owner_usage WHERE owner_id = ? AND day = ?")
      .bind(ownerId, day)
      .first<{ photos_used: number }>();
    expect(usageRow?.photos_used).toBe(1);

    const after = await mappingRow(batch.id, "p1");
    expect(after?.photo_id).toBeTruthy();
    expect(await countPhotosForOwner(ownerId)).toBe(1);
  });

  it("a retry does not cascade its own mapping row away", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    await seedOwner(token);
    const batch = await createBatch(token, "cascade-batch");

    const first = await bulk(`/batches/${batch.id}/photos/p1`, {
      method: "PUT",
      headers: authHeaders(token),
      body: photoForm(),
    });
    expect(first.status).toBe(201);
    const photo = await readOk<{ photo_id: string }>(first);

    // A retry under the same client key, after the mapping already carries
    // this photo id (an `INSERT OR REPLACE` would have cascade-deleted this
    // very row before `storePhotoUpload`'s upsert fix landed).
    const retry = await bulk(`/batches/${batch.id}/photos/p1`, {
      method: "PUT",
      headers: authHeaders(token),
      body: photoForm(),
    });
    expect(retry.status).toBe(200);

    const mapping = await mappingRow(batch.id, "p1");
    expect(mapping, "the mapping row survived a same-key retry").toBeTruthy();
    expect(mapping?.photo_id).toBe(photo.photo_id);
  });

  it("an exhausted daily allowance still writes nothing anywhere", async () => {
    await seedStandardPostalCodes();
    setTestEnvVar("BULK_OWNER_DAILY_PHOTOS", "0");
    try {
      const token = freshOwnerToken();
      const ownerId = await seedOwner(token);
      const batch = await createBatch(token, "exhausted-batch");

      const res = await bulk(`/batches/${batch.id}/photos/p1`, {
        method: "PUT",
        headers: authHeaders(token),
        body: photoForm(),
      });
      expect(res.status).toBe(429);
      const err = await readErr(res);
      expect(err.code).toBe("rate_limited");

      const mapping = await env.DB.prepare("SELECT COUNT(*) AS n FROM upload_batch_photos WHERE batch_id = ?").bind(batch.id).first<{ n: number }>();
      expect(mapping?.n ?? 0).toBe(0);
      expect(await countPhotosForOwner(ownerId)).toBe(0);

      const expectedId = await reservedPhotoId(batch.id, "p1");
      const { objects } = await env.BUCKET.list({ prefix: `photos/${expectedId}/` });
      expect(objects.length).toBe(0);
    } finally {
      setTestEnvVar("BULK_OWNER_DAILY_PHOTOS", "450");
    }
  });
});

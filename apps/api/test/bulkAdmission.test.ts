/**
 * Estate bulk upload — admission. `requireGrant()` gates identity (no
 * header, an expired/revoked/foreign grant); the exact counters in
 * `src/bulk/grants.ts` gate quantity, in D1, never KV.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bulkRoutes } from "../src/routes/bulk.js";
import { ulid } from "../src/lib/ids.js";
import { sha256Hex } from "../src/lib/digest.js";
import { authHeaders, fakeFile, fakeJpegBytes, freshClientIp, freshOwnerToken, readErr, readOk, seedStandardPostalCodes, setTestEnvVar } from "./helpers.js";

const ADMIN_TOKEN = "test-admin-token-bulk-admission";
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

interface GrantSummary {
  id: string;
  batch_id: string | null;
  items_remaining: number;
  photos_remaining: number;
  expires_at: number;
}

async function mintGrant(ownerId: string, extra: { items?: number; photos?: number } = {}): Promise<GrantSummary> {
  setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
  const res = await SELF.fetch("http://x/api/admin/bulk/grants", {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json", "CF-Connecting-IP": freshClientIp() },
    body: JSON.stringify({ owner_id: ownerId, ...extra }),
  });
  return readOk<GrantSummary>(res);
}

function bulkHeaders(token: string, grantId?: string): Record<string, string> {
  return { ...authHeaders(token), "Content-Type": "application/json", ...(grantId ? { "x-bulk-grant": grantId } : {}) };
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

async function createBatch(token: string, grantId: string, clientBatchKey: string): Promise<{ id: string }> {
  const res = await bulk("/batches", {
    method: "POST",
    headers: bulkHeaders(token, grantId),
    body: JSON.stringify({ client_batch_key: clientBatchKey, name: "Estate", country: "US", postal_code: "02144" }),
  });
  return readOk<{ id: string }>(res);
}

describe("estate bulk upload: admission", () => {
  it("403s with no grant header", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    await seedOwner(token);

    const res = await bulk("/batches", {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ client_batch_key: "no-grant", name: "Estate", country: "US", postal_code: "02144" }),
    });
    expect(res.status).toBe(403);
    const err = await readErr(res);
    expect(err.code).toBe("forbidden");
  });

  it("403s an expired grant", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const ownerId = await seedOwner(token);

    const grantId = ulid();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO bulk_grants (id, owner_id, batch_id, items_remaining, photos_remaining, issued_by, expires_at, created_at)
       VALUES (?, ?, NULL, 10, 10, 'admin', ?, ?)`,
    )
      .bind(grantId, ownerId, now - 1000, now - 60_000)
      .run();

    const res = await bulk("/batches", {
      method: "POST",
      headers: bulkHeaders(token, grantId),
      body: JSON.stringify({ client_batch_key: "expired-grant", name: "Estate", country: "US", postal_code: "02144" }),
    });
    expect(res.status).toBe(403);
  });

  it("403s a revoked grant", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const ownerId = await seedOwner(token);

    const grantId = ulid();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO bulk_grants (id, owner_id, batch_id, items_remaining, photos_remaining, issued_by, expires_at, revoked_at, created_at)
       VALUES (?, ?, NULL, 10, 10, 'admin', ?, ?, ?)`,
    )
      .bind(grantId, ownerId, now + 100_000, now, now)
      .run();

    const res = await bulk("/batches", {
      method: "POST",
      headers: bulkHeaders(token, grantId),
      body: JSON.stringify({ client_batch_key: "revoked-grant", name: "Estate", country: "US", postal_code: "02144" }),
    });
    expect(res.status).toBe(403);
  });

  it("403s a grant that belongs to a different owner", async () => {
    await seedStandardPostalCodes();
    const tokenA = freshOwnerToken();
    const ownerA = await seedOwner(tokenA);
    const tokenB = freshOwnerToken();
    await seedOwner(tokenB);

    const grantForA = await mintGrant(ownerA);

    // Owner B presents Owner A's grant id alongside Owner B's own token.
    const res = await bulk("/batches", {
      method: "POST",
      headers: bulkHeaders(tokenB, grantForA.id),
      body: JSON.stringify({ client_batch_key: "foreign-grant", name: "Estate", country: "US", postal_code: "02144" }),
    });
    expect(res.status).toBe(403);
    const err = await readErr(res);
    expect(err.code).toBe("forbidden");
  });

  it("the item allowance is exact: a grant with 2 items lets exactly 2 through and 429s the third", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const ownerId = await seedOwner(token);
    const grant = await mintGrant(ownerId, { items: 2, photos: 10 });
    const batch = await createBatch(token, grant.id, "item-allowance");

    const first = await bulk(`/batches/${batch.id}/items/i1`, {
      method: "PUT",
      headers: bulkHeaders(token, grant.id),
      body: JSON.stringify({ fields: { title: "First", story: VALID_STORY, category: "other" } }),
    });
    expect(first.status).toBe(201);

    const second = await bulk(`/batches/${batch.id}/items/i2`, {
      method: "PUT",
      headers: bulkHeaders(token, grant.id),
      body: JSON.stringify({ fields: { title: "Second", story: VALID_STORY, category: "other" } }),
    });
    expect(second.status).toBe(201);

    const third = await bulk(`/batches/${batch.id}/items/i3`, {
      method: "PUT",
      headers: bulkHeaders(token, grant.id),
      body: JSON.stringify({ fields: { title: "Third", story: VALID_STORY, category: "other" } }),
    });
    expect(third.status).toBe(429);
    const err = await readErr(third);
    expect(err.code).toBe("rate_limited");

    // Nothing charged for the refused third item, and it was never created.
    const grantRow = await env.DB.prepare("SELECT items_remaining FROM bulk_grants WHERE id = ?").bind(grant.id).first<{ items_remaining: number }>();
    expect(grantRow?.items_remaining).toBe(0);
    const itemRow = await env.DB.prepare(
      "SELECT COUNT(*) as n FROM upload_batch_items WHERE batch_id = ? AND client_item_id = 'i3'",
    )
      .bind(batch.id)
      .first<{ n: number }>();
    expect(itemRow?.n ?? 0).toBe(0);
  });

  it("the photo allowance is exact: a grant with 2 photos lets exactly 2 through and 429s the third", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const ownerId = await seedOwner(token);
    const grant = await mintGrant(ownerId, { items: 10, photos: 2 });
    const batch = await createBatch(token, grant.id, "photo-allowance");

    const first = await bulk(`/batches/${batch.id}/photos/p1`, {
      method: "PUT",
      headers: { ...authHeaders(token), "x-bulk-grant": grant.id },
      body: photoForm(),
    });
    expect(first.status).toBe(201);

    const second = await bulk(`/batches/${batch.id}/photos/p2`, {
      method: "PUT",
      headers: { ...authHeaders(token), "x-bulk-grant": grant.id },
      body: photoForm(),
    });
    expect(second.status).toBe(201);

    const third = await bulk(`/batches/${batch.id}/photos/p3`, {
      method: "PUT",
      headers: { ...authHeaders(token), "x-bulk-grant": grant.id },
      body: photoForm(),
    });
    expect(third.status).toBe(429);
    const err = await readErr(third);
    expect(err.code).toBe("rate_limited");

    // Nothing charged for the refused third photo.
    const grantRow = await env.DB.prepare("SELECT photos_remaining FROM bulk_grants WHERE id = ?").bind(grant.id).first<{ photos_remaining: number }>();
    expect(grantRow?.photos_remaining).toBe(0);
  });

  it("a retried upload under the same client key does not spend a second allowance", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const ownerId = await seedOwner(token);
    const grant = await mintGrant(ownerId, { items: 10, photos: 1 });
    const batch = await createBatch(token, grant.id, "retry-allowance");

    const first = await bulk(`/batches/${batch.id}/photos/only`, {
      method: "PUT",
      headers: { ...authHeaders(token), "x-bulk-grant": grant.id },
      body: photoForm(),
    });
    expect(first.status).toBe(201);

    // The grant had exactly one photo of allowance — if the retry spent a
    // second one there would be nothing left for a genuinely new photo.
    const retry = await bulk(`/batches/${batch.id}/photos/only`, {
      method: "PUT",
      headers: { ...authHeaders(token), "x-bulk-grant": grant.id },
      body: photoForm(),
    });
    expect(retry.status).toBe(200);

    const grantRow = await env.DB.prepare("SELECT photos_remaining FROM bulk_grants WHERE id = ?").bind(grant.id).first<{ photos_remaining: number }>();
    expect(grantRow?.photos_remaining).toBe(0);

    const secondReal = await bulk(`/batches/${batch.id}/photos/second`, {
      method: "PUT",
      headers: { ...authHeaders(token), "x-bulk-grant": grant.id },
      body: photoForm(),
    });
    expect(secondReal.status).toBe(429);
  });

  it("the owner/day ceiling bites across two different batches", async () => {
    await seedStandardPostalCodes();
    setTestEnvVar("BULK_OWNER_DAILY_PHOTOS", "1");
    try {
      const token = freshOwnerToken();
      const ownerId = await seedOwner(token);
      const grant = await mintGrant(ownerId, { items: 10, photos: 10 });

      const batchOne = await createBatch(token, grant.id, "owner-ceiling-1");
      const batchTwo = await createBatch(token, grant.id, "owner-ceiling-2");

      const firstUpload = await bulk(`/batches/${batchOne.id}/photos/p1`, {
        method: "PUT",
        headers: { ...authHeaders(token), "x-bulk-grant": grant.id },
        body: photoForm(),
      });
      expect(firstUpload.status).toBe(201);

      // A second batch, same owner, same day: the per-owner ceiling — not
      // the per-batch grant — is what refuses this one.
      const secondUpload = await bulk(`/batches/${batchTwo.id}/photos/p1`, {
        method: "PUT",
        headers: { ...authHeaders(token), "x-bulk-grant": grant.id },
        body: photoForm(),
      });
      expect(secondUpload.status).toBe(429);
      const err = await readErr(secondUpload);
      expect(err.code).toBe("rate_limited");
      expect(err.retryAfter).toBeDefined();

      // The grant itself still had allowance — it's the owner/day row that
      // refused, so the grant's own counter must be back where it was
      // (settleDebit's refund, since the grant side of that debit landed
      // and the usage side refused).
      const grantRow = await env.DB.prepare("SELECT photos_remaining FROM bulk_grants WHERE id = ?").bind(grant.id).first<{ photos_remaining: number }>();
      expect(grantRow?.photos_remaining).toBe(9);
    } finally {
      setTestEnvVar("BULK_OWNER_DAILY_PHOTOS", "450");
    }
  });
});

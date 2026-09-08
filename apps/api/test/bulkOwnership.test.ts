/**
 * Estate bulk upload — ownership boundaries. Every guard here answers "is
 * this someone else's?" with 404, never 403: `findBatchById` in
 * `src/bulk/batches.ts` scopes every lookup by `owner_id = ?` in the query
 * itself, so a batch id that belongs to a stranger has to come back exactly
 * like a batch id that doesn't exist at all.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bulkRoutes } from "../src/routes/bulk.js";
import { ulid } from "../src/lib/ids.js";
import { sha256Hex } from "../src/lib/digest.js";
import { authHeaders, fakeFile, fakeJpegBytes, freshClientIp, freshOwnerToken, readOk, seedStandardPostalCodes } from "./helpers.js";

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

interface BatchBody {
  id: string;
  revision: number;
}
interface ItemBody {
  client_item_id: string;
}
interface PhotoBody {
  photo_id: string;
}

describe("estate bulk upload: ownership", () => {
  it("a second owner cannot read, patch, delete, upload into, or attach to the first owner's batch", async () => {
    await seedStandardPostalCodes();

    const tokenA = freshOwnerToken();
    await seedOwner(tokenA);

    const tokenB = freshOwnerToken();
    await seedOwner(tokenB);

    const createRes = await bulk("/batches", {
      method: "POST",
      headers: bulkHeaders(tokenA),
      body: JSON.stringify({ client_batch_key: "owner-a-estate", name: "Owner A's estate", country: "US", postal_code: "02144" }),
    });
    expect(createRes.status).toBe(201);
    const batch = await readOk<BatchBody>(createRes);

    const createItemRes = await bulk(`/batches/${batch.id}/items/item-1`, {
      method: "PUT",
      headers: bulkHeaders(tokenA),
      body: JSON.stringify({ fields: { title: "A quiet teacup", story: VALID_STORY, category: "home_kitchen" } }),
    });
    expect(createItemRes.status).toBe(201);
    const item = await readOk<ItemBody>(createItemRes);

    const uploadRes = await bulk(`/batches/${batch.id}/photos/photo-1`, {
      method: "PUT",
      headers: authHeaders(tokenA),
      body: photoForm(),
    });
    expect(uploadRes.status).toBe(201);
    const photo = await readOk<PhotoBody>(uploadRes);

    // --- Owner B, with their own owner token, reaches for A's batch ---
    const getAsB = await bulk(`/batches/${batch.id}`, { headers: bulkHeaders(tokenB) });
    expect(getAsB.status).toBe(404);

    const patchAsB = await bulk(`/batches/${batch.id}`, {
      method: "PATCH",
      headers: bulkHeaders(tokenB),
      body: JSON.stringify({ expected_revision: 1, name: "Hijacked" }),
    });
    expect(patchAsB.status).toBe(404);

    const putItemAsB = await bulk(`/batches/${batch.id}/items/item-2`, {
      method: "PUT",
      headers: bulkHeaders(tokenB),
      body: JSON.stringify({ fields: { title: "Stolen item", story: VALID_STORY, category: "other" } }),
    });
    expect(putItemAsB.status).toBe(404);

    const deleteItemAsB = await bulk(`/batches/${batch.id}/items/item-1`, { method: "DELETE", headers: bulkHeaders(tokenB) });
    expect(deleteItemAsB.status).toBe(404);

    const uploadAsB = await bulk(`/batches/${batch.id}/photos/photo-2`, {
      method: "PUT",
      headers: authHeaders(tokenB),
      body: photoForm(),
    });
    expect(uploadAsB.status).toBe(404);

    const deletePhotoAsB = await bulk(`/batches/${batch.id}/photos/photo-1`, { method: "DELETE", headers: bulkHeaders(tokenB) });
    expect(deletePhotoAsB.status).toBe(404);

    const deleteBatchAsB = await bulk(`/batches/${batch.id}`, { method: "DELETE", headers: bulkHeaders(tokenB) });
    expect(deleteBatchAsB.status).toBe(404);

    // Owner A's batch and item are exactly as they were — none of the
    // attempts above touched anything.
    const detailRes = await bulk(`/batches/${batch.id}`, { headers: bulkHeaders(tokenA) });
    const detail = await readOk<{ revision: number; state: string; items: { client_item_id: string }[] }>(detailRes);
    expect(detail.state).toBe("draft");
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0]?.client_item_id).toBe(item.client_item_id);

    // --- The photo is not reachable at /i/:id/thumb without owner A's token ---
    const anonImage = await SELF.fetch(`http://x/i/${photo.photo_id}/thumb`, { headers: { "CF-Connecting-IP": freshClientIp() } });
    expect(anonImage.status).toBe(404);

    const bImage = await SELF.fetch(`http://x/i/${photo.photo_id}/thumb`, {
      headers: { ...authHeaders(tokenB) },
    });
    expect(bImage.status).toBe(404);

    const aImage = await SELF.fetch(`http://x/i/${photo.photo_id}/thumb`, {
      headers: { ...authHeaders(tokenA) },
    });
    expect(aImage.status).toBe(200);
  });

  it("a draft item never appears in GET /api/feed", async () => {
    await seedStandardPostalCodes();

    const token = freshOwnerToken();
    await seedOwner(token);

    const createRes = await bulk("/batches", {
      method: "POST",
      headers: bulkHeaders(token),
      body: JSON.stringify({ client_batch_key: "feed-check", name: "Estate", country: "US", postal_code: "02144" }),
    });
    const batch = await readOk<BatchBody>(createRes);

    const uniqueTitle = `Never in the feed ${ulid()}`;
    const itemRes = await bulk(`/batches/${batch.id}/items/only-item`, {
      method: "PUT",
      headers: bulkHeaders(token),
      body: JSON.stringify({ fields: { title: uniqueTitle, story: VALID_STORY, category: "other" } }),
    });
    expect(itemRes.status).toBe(201);

    // Not in `listings` at all — the migration's whole reason for existing.
    const row = await env.DB.prepare("SELECT COUNT(*) as n FROM listings WHERE title = ?").bind(uniqueTitle).first<{ n: number }>();
    expect(row?.n ?? 0).toBe(0);

    // And not visible through the real feed route either.
    const feedRes = await SELF.fetch("http://x/api/feed", { headers: { "CF-Connecting-IP": freshClientIp() } });
    expect(feedRes.status).toBe(200);
    const feedBody = await readOk<{ items: { title: string }[] }>(feedRes);
    expect(feedBody.items.some((listing) => listing.title === uniqueTitle)).toBe(false);
  });
});

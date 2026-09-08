/**
 * Estate bulk upload — the happy path: create a batch, upsert an item,
 * upload a photo, group them, and read the assembled detail back. Every
 * retry in here uses the exact same client key a second time and asserts
 * it resolves to the same row rather than a duplicate — the whole point of
 * `client_batch_key`/`client_item_id`/`client_photo_id`.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bulkRoutes } from "../src/routes/bulk.js";
import { ulid } from "../src/lib/ids.js";
import { sha256Hex } from "../src/lib/digest.js";
import {
  authHeaders,
  fakeFile,
  fakeJpegBytes,
  freshClientIp,
  freshOwnerToken,
  readErr,
  readOk,
  seedStandardPostalCodes,
  setTestEnvVar,
} from "./helpers.js";

const ADMIN_TOKEN = "test-admin-token-bulk-batches";
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
  return {
    ...authHeaders(token),
    "Content-Type": "application/json",
    ...(grantId ? { "x-bulk-grant": grantId } : {}),
  };
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

interface BatchSummaryBody {
  id: string;
  client_batch_key: string;
  revision: number;
  state: string;
  item_count: number;
  ready_count: number;
  photo_count: number;
}

interface BatchItemBody {
  id: string;
  client_item_id: string;
  revision: number;
  ready: boolean;
  blocked_reason: string | null;
  photo_client_ids: string[];
}

interface BatchPhotoBody {
  client_photo_id: string;
  photo_id: string;
  item_client_id: string | null;
  url_thumb: string;
}

interface BatchDetailBody extends BatchSummaryBody {
  items: BatchItemBody[];
  photos: BatchPhotoBody[];
}

describe("estate bulk upload: batches, items, photos", () => {
  it("creates a batch, upserts an item, uploads a photo, groups them, and every retry is idempotent", async () => {
    await seedStandardPostalCodes();

    const token = freshOwnerToken();
    const ownerId = await seedOwner(token);
    const grant = await mintGrant(ownerId, { items: 10, photos: 10 });

    // --- POST /batches -------------------------------------------------
    const createBody = { client_batch_key: "estate-42", name: "Mum's house", country: "US", postal_code: "02144" };
    const createRes = await bulk("/batches", { method: "POST", headers: bulkHeaders(token, grant.id), body: JSON.stringify(createBody) });
    expect(createRes.status).toBe(201);
    const batch = await readOk<BatchSummaryBody>(createRes);
    expect(batch.state).toBe("draft");
    expect(batch.revision).toBe(1);
    expect(batch.item_count).toBe(0);
    expect(batch.photo_count).toBe(0);

    // A retry of the exact same create resolves to the same row.
    const retryCreateRes = await bulk("/batches", { method: "POST", headers: bulkHeaders(token, grant.id), body: JSON.stringify(createBody) });
    expect(retryCreateRes.status).toBe(201);
    const retryBatch = await readOk<BatchSummaryBody>(retryCreateRes);
    expect(retryBatch.id).toBe(batch.id);
    expect(retryBatch.revision).toBe(1);

    // --- PUT items/:clientItemId (create) -------------------------------
    const createItemRes = await bulk(`/batches/${batch.id}/items/teacup`, {
      method: "PUT",
      headers: bulkHeaders(token, grant.id),
      body: JSON.stringify({ fields: { title: "A quiet teacup", story: VALID_STORY, category: "home_kitchen" }, room_label: "front bedroom" }),
    });
    expect(createItemRes.status).toBe(201);
    const item1 = await readOk<BatchItemBody>(createItemRes);
    expect(item1.revision).toBe(1);
    // No photos yet — the real CreateListingInput has to refuse it, and the
    // refusal has to name a photo, not restate some other rule.
    expect(item1.ready).toBe(false);
    expect(item1.blocked_reason).toBe("Add at least one photo.");

    // A retry of the exact same create (no expected_revision — see
    // UpsertBatchItemInput's own comment) resolves to the same row rather
    // than a conflict or a second item.
    const retryItemRes = await bulk(`/batches/${batch.id}/items/teacup`, {
      method: "PUT",
      headers: bulkHeaders(token, grant.id),
      body: JSON.stringify({ fields: { title: "A quiet teacup", story: VALID_STORY, category: "home_kitchen" } }),
    });
    expect(retryItemRes.status).toBe(200);
    const retryItem = await readOk<BatchItemBody>(retryItemRes);
    expect(retryItem.id).toBe(item1.id);
    expect(retryItem.revision).toBe(1);

    // --- PUT photos/:clientPhotoId --------------------------------------
    const uploadRes = await bulk(`/batches/${batch.id}/photos/cover`, {
      method: "PUT",
      headers: { ...authHeaders(token), "x-bulk-grant": grant.id },
      body: photoForm(),
    });
    expect(uploadRes.status).toBe(201);
    const photo1 = await readOk<BatchPhotoBody>(uploadRes);
    expect(photo1.item_client_id).toBeNull();
    expect(photo1.url_thumb).toBe(`/i/${photo1.photo_id}/thumb`);

    // A retried upload under the same client key resolves to the same
    // photo — this is what the D1 unique index buys, in place of the KV
    // replay cache.
    const retryUploadRes = await bulk(`/batches/${batch.id}/photos/cover`, {
      method: "PUT",
      headers: { ...authHeaders(token), "x-bulk-grant": grant.id },
      body: photoForm(),
    });
    expect(retryUploadRes.status).toBe(200);
    const retryPhoto = await readOk<BatchPhotoBody>(retryUploadRes);
    expect(retryPhoto.photo_id).toBe(photo1.photo_id);

    // --- PUT items/:clientItemId (update: attach the photo) ------------
    const attachRes = await bulk(`/batches/${batch.id}/items/teacup`, {
      method: "PUT",
      headers: bulkHeaders(token, grant.id),
      body: JSON.stringify({
        expected_revision: item1.revision,
        fields: { title: "A quiet teacup", story: VALID_STORY, category: "home_kitchen" },
        photo_client_ids: ["cover"],
      }),
    });
    expect(attachRes.status).toBe(200);
    const attached = await readOk<BatchItemBody>(attachRes);
    expect(attached.revision).toBe(item1.revision + 1);
    expect(attached.photo_client_ids).toEqual(["cover"]);
    // Now that it has a title, a story, a category and a photo, the real
    // CreateListingInput passes it.
    expect(attached.ready).toBe(true);
    expect(attached.blocked_reason).toBeNull();

    // A stale expected_revision — the one the item held *before* the
    // attach above — is a 409, not a silent overwrite.
    const staleRes = await bulk(`/batches/${batch.id}/items/teacup`, {
      method: "PUT",
      headers: bulkHeaders(token, grant.id),
      body: JSON.stringify({ expected_revision: item1.revision, fields: { title: "Renamed", story: VALID_STORY, category: "home_kitchen" } }),
    });
    expect(staleRes.status).toBe(409);
    const staleErr = await readErr(staleRes);
    expect(staleErr.code).toBe("conflict");

    // --- GET /batches/:id: grouping, counts, ready ----------------------
    const detailRes = await bulk(`/batches/${batch.id}`, { headers: bulkHeaders(token) });
    expect(detailRes.status).toBe(200);
    const detail = await readOk<BatchDetailBody>(detailRes);
    expect(detail.item_count).toBe(1);
    expect(detail.ready_count).toBe(1);
    expect(detail.photo_count).toBe(1);
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0]?.client_item_id).toBe("teacup");
    expect(detail.items[0]?.photo_client_ids).toEqual(["cover"]);
    expect(detail.photos).toHaveLength(1);
    expect(detail.photos[0]?.item_client_id).toBe("teacup");
  });

  it("PATCH /batches/:id 409s on a revision mismatch and only re-resolves geo when the postcode changes", async () => {
    await seedStandardPostalCodes();

    const token = freshOwnerToken();
    const ownerId = await seedOwner(token);
    const grant = await mintGrant(ownerId);

    const createRes = await bulk("/batches", {
      method: "POST",
      headers: bulkHeaders(token, grant.id),
      body: JSON.stringify({ client_batch_key: "patch-me", name: "Original name", country: "US", postal_code: "02144" }),
    });
    const batch = await readOk<{ id: string; revision: number; place_name: string }>(createRes);
    expect(batch.place_name).toBe("Somerville");

    // Name-only edit: no postcode change, revision must match.
    const renameRes = await bulk(`/batches/${batch.id}`, {
      method: "PATCH",
      headers: bulkHeaders(token, grant.id),
      body: JSON.stringify({ expected_revision: batch.revision, name: "Renamed estate" }),
    });
    expect(renameRes.status).toBe(200);
    const renamed = await readOk<{ revision: number; name: string; place_name: string; postal_code: string }>(renameRes);
    expect(renamed.name).toBe("Renamed estate");
    expect(renamed.revision).toBe(batch.revision + 1);
    // Postcode untouched.
    expect(renamed.place_name).toBe("Somerville");
    expect(renamed.postal_code).toBe("02144");

    // Stale revision — the one before the rename above.
    const staleRes = await bulk(`/batches/${batch.id}`, {
      method: "PATCH",
      headers: bulkHeaders(token, grant.id),
      body: JSON.stringify({ expected_revision: batch.revision, name: "Should not land" }),
    });
    expect(staleRes.status).toBe(409);

    // A real postcode change re-resolves geo.
    const movedRes = await bulk(`/batches/${batch.id}`, {
      method: "PATCH",
      headers: bulkHeaders(token, grant.id),
      body: JSON.stringify({ expected_revision: renamed.revision, postal_code: "M5V", country: "CA" }),
    });
    expect(movedRes.status).toBe(200);
    const moved = await readOk<{ place_name: string; country: string }>(movedRes);
    expect(moved.place_name).toBe("Toronto");
    expect(moved.country).toBe("CA");
  });

  it("DELETE /batches/:id cancels the batch, clears photo retention, and reports listings it does not undo", async () => {
    await seedStandardPostalCodes();

    const token = freshOwnerToken();
    const ownerId = await seedOwner(token);
    const grant = await mintGrant(ownerId);

    const createRes = await bulk("/batches", {
      method: "POST",
      headers: bulkHeaders(token, grant.id),
      body: JSON.stringify({ client_batch_key: "cancel-me", name: "To cancel", country: "US", postal_code: "02144" }),
    });
    const batch = await readOk<{ id: string }>(createRes);

    const uploadRes = await bulk(`/batches/${batch.id}/photos/only`, {
      method: "PUT",
      headers: { ...authHeaders(token), "x-bulk-grant": grant.id },
      body: photoForm(),
    });
    const photo = await readOk<BatchPhotoBody>(uploadRes);

    const before = await env.DB.prepare("SELECT retain_until FROM photos WHERE id = ?").bind(photo.photo_id).first<{ retain_until: number | null }>();
    expect(before?.retain_until).not.toBeNull();

    const cancelRes = await bulk(`/batches/${batch.id}`, { method: "DELETE", headers: bulkHeaders(token) });
    expect(cancelRes.status).toBe(200);
    const cancelled = await readOk<{ id: string; state: string; listing_ids: string[] }>(cancelRes);
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.listing_ids).toEqual([]);

    const after = await env.DB.prepare("SELECT retain_until FROM photos WHERE id = ?").bind(photo.photo_id).first<{ retain_until: number | null }>();
    expect(after?.retain_until).toBeNull();
  });
});

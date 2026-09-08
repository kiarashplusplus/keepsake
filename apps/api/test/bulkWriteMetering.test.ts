/**
 * Every write on `bulkRoutes` is behind the router-level `burst("RL_WRITE")`
 * brake — same shape and same reasoning as `test/listingWriteMetering.test.ts`
 * (issue #168): a per-route decision is what let that guard drift on
 * `listingRoutes` before it existed, so the test that matters most is the
 * last one below, which enumerates the router's own registrations and fails
 * if a write route is ever added outside the guard.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bulkRoutes } from "../src/routes/bulk.js";
import { ulid } from "../src/lib/ids.js";
import { sha256Hex } from "../src/lib/digest.js";
import { authHeaders, fakeFile, fakeJpegBytes, freshOwnerToken, installDenyingRateLimiter, readOk, seedStandardPostalCodes } from "./helpers.js";

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

/** Every non-GET route this router registers, and the request that reaches
 * it — kept in one place so the enumeration test below can prove it is the
 * *whole* list. `:id`/`:clientItemId`/`:clientPhotoId` are filled from a
 * real batch/item/photo created before the limiter is installed, the same
 * way `listingWriteMetering.test.ts` seeds a real listing first. */
const WRITE_ROUTES: { method: string; path: string; url: (ids: { batchId: string }) => string; body?: unknown; multipart?: boolean }[] = [
  {
    method: "POST",
    path: "/batches",
    url: () => "/batches",
    body: { client_batch_key: "metering", name: "Estate", country: "US", postal_code: "02144" },
  },
  { method: "PATCH", path: "/batches/:id", url: ({ batchId }) => `/batches/${batchId}`, body: { expected_revision: 1, name: "Edited" } },
  { method: "DELETE", path: "/batches/:id", url: ({ batchId }) => `/batches/${batchId}` },
  {
    method: "PUT",
    path: "/batches/:id/items/:clientItemId",
    url: ({ batchId }) => `/batches/${batchId}/items/item-1`,
    body: { fields: { title: "A quiet teacup" } },
  },
  { method: "DELETE", path: "/batches/:id/items/:clientItemId", url: ({ batchId }) => `/batches/${batchId}/items/item-1` },
  { method: "PUT", path: "/batches/:id/photos/:clientPhotoId", url: ({ batchId }) => `/batches/${batchId}/photos/photo-1`, multipart: true },
  { method: "DELETE", path: "/batches/:id/photos/:clientPhotoId", url: ({ batchId }) => `/batches/${batchId}/photos/photo-1` },
  {
    method: "POST",
    path: "/batches/:id/photos/:clientPhotoId/suggest",
    url: ({ batchId }) => `/batches/${batchId}/photos/photo-1/suggest`,
  },
  {
    method: "POST",
    path: "/batches/:id/submit",
    url: ({ batchId }) => `/batches/${batchId}/submit`,
    body: { op_key: "submit-metering", date_of_birth: "1990-01-01", items: [{ client_item_id: "item-1", revision: 1 }] },
  },
  { method: "POST", path: "/operations/:id/retry", url: () => "/operations/op-1/retry" },
  { method: "DELETE", path: "/operations/:id", url: () => "/operations/op-1" },
];

describe("every write on bulkRoutes is behind the router-level burst brake", () => {
  it("429s every non-GET route when RL_WRITE denies, before auth or a handler runs", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    await seedOwner(token);
    const batch = await bulk("/batches", {
      method: "POST",
      headers: bulkHeaders(token),
      body: JSON.stringify({ client_batch_key: "seed", name: "Estate", country: "US", postal_code: "02144" }),
    }).then((res) => readOk<{ id: string }>(res));

    const restore = installDenyingRateLimiter("RL_WRITE");
    try {
      for (const route of WRITE_ROUTES) {
        const path = route.url({ batchId: batch.id });
        const init: RequestInit = { method: route.method };
        if (route.multipart) {
          // Deliberately no `Authorization` header either — the
          // limiter has to sit in front of everything, and a 429 with no
          // credential presented at all is the proof it does.
          init.body = photoForm();
        } else if (route.body) {
          init.headers = { "Content-Type": "application/json" };
          init.body = JSON.stringify(route.body);
        }
        const res = await bulk(path, init);
        expect(`${route.method} ${route.path} -> ${res.status}`).toBe(`${route.method} ${route.path} -> 429`);
      }
    } finally {
      restore();
    }
  });

  it("leaves GET alone — the read path keeps its own RL_READ accounting", async () => {
    const restore = installDenyingRateLimiter("RL_WRITE");
    try {
      const token = freshOwnerToken();
      await seedOwner(token);
      const res = await bulk("/batches", { headers: authHeaders(token) });
      expect(res.status).toBe(200);
    } finally {
      restore();
    }
  });

  /**
   * The guard on the guard. `bulkRoutes.routes` is Hono's own registry — one
   * entry per registered handler, so middleware and handlers both appear —
   * and the router-level brake shows up as `["POST", "/*"]` and friends.
   * Every other non-GET entry has to be in `WRITE_ROUTES`, which the first
   * test exercises. Add an unguarded write route to `routes/bulk.ts` and
   * this fails, naming it.
   */
  it("enumerates the router: no non-GET route exists outside WRITE_ROUTES", () => {
    const covered = new Set(WRITE_ROUTES.map((route) => `${route.method} ${route.path}`));
    const registered = new Set(
      bulkRoutes.routes.filter((route) => route.method !== "GET" && route.path !== "/*").map((route) => `${route.method} ${route.path}`),
    );
    expect([...registered].filter((entry) => !covered.has(entry))).toEqual([]);
    expect([...covered].filter((entry) => !registered.has(entry))).toEqual([]);
  });
});

/**
 * Estate bulk upload — the `BULK_UPLOAD` kill switch. `featureFlag(...)` is
 * mounted first on `bulkRoutes`, ahead of everything else including `GET`,
 * and answers a disabled feature with `not_found`, never `forbidden` — see
 * `src/middleware/featureFlag.ts`'s own comment on why.
 */
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { bulkRoutes } from "../src/routes/bulk.js";
import { ulid } from "../src/lib/ids.js";
import { sha256Hex } from "../src/lib/digest.js";
import { authHeaders, fakeFile, fakeJpegBytes, freshClientIp, freshOwnerToken, readOk, seedStandardPostalCodes, setTestEnvVar } from "./helpers.js";

const ADMIN_TOKEN = "test-admin-token-bulk-feature-flag";

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
}

async function mintGrant(ownerId: string): Promise<GrantSummary> {
  setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
  const res = await SELF.fetch("http://x/api/admin/bulk/grants", {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json", "CF-Connecting-IP": freshClientIp() },
    body: JSON.stringify({ owner_id: ownerId }),
  });
  return readOk<GrantSummary>(res);
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

describe("BULK_UPLOAD feature flag", () => {
  afterEach(() => setTestEnvVar("BULK_UPLOAD", "1"));

  it("404s every bulk route when BULK_UPLOAD is off — reads included, and never 403", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const ownerId = await seedOwner(token);
    const grant = await mintGrant(ownerId);

    // Create a real batch/item/photo while the flag is still on, so the
    // routes below are refusing a request that *would* otherwise have
    // succeeded, not one that was already going to 404 for some other
    // reason.
    const createRes = await bulk("/batches", {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json", "x-bulk-grant": grant.id },
      body: JSON.stringify({ client_batch_key: "flag-check", name: "Estate", country: "US", postal_code: "02144" }),
    });
    expect(createRes.status).toBe(201);
    const batch = await readOk<{ id: string }>(createRes);

    setTestEnvVar("BULK_UPLOAD", "0");

    const headers = { ...authHeaders(token), "Content-Type": "application/json", "x-bulk-grant": grant.id };

    const routes: { method: string; path: string; init?: RequestInit }[] = [
      { method: "POST", path: "/batches", init: { method: "POST", headers, body: JSON.stringify({ client_batch_key: "x", name: "x", country: "US", postal_code: "02144" }) } },
      { method: "GET", path: "/batches", init: { headers } },
      { method: "GET", path: `/batches/${batch.id}`, init: { headers } },
      { method: "PATCH", path: `/batches/${batch.id}`, init: { method: "PATCH", headers, body: JSON.stringify({ expected_revision: 1, name: "y" }) } },
      { method: "DELETE", path: `/batches/${batch.id}`, init: { method: "DELETE", headers } },
      {
        method: "PUT",
        path: `/batches/${batch.id}/items/i1`,
        init: { method: "PUT", headers, body: JSON.stringify({ fields: { title: "x" } }) },
      },
      { method: "DELETE", path: `/batches/${batch.id}/items/i1`, init: { method: "DELETE", headers } },
      {
        method: "PUT",
        path: `/batches/${batch.id}/photos/p1`,
        init: { method: "PUT", headers: { ...authHeaders(token), "x-bulk-grant": grant.id }, body: photoForm() },
      },
      { method: "DELETE", path: `/batches/${batch.id}/photos/p1`, init: { method: "DELETE", headers } },
    ];

    for (const route of routes) {
      const res = await bulk(route.path, route.init);
      expect(`${route.method} ${route.path} -> ${res.status}`).toBe(`${route.method} ${route.path} -> 404`);
      const body = (await res.json()) as { ok: boolean; error?: { code: string } };
      expect(body.ok).toBe(false);
      expect(body.error?.code).toBe("not_found");
    }
  });

  it("serves normally again once the flag is back on", async () => {
    await seedStandardPostalCodes();
    setTestEnvVar("BULK_UPLOAD", "0");
    const token = freshOwnerToken();
    const ownerId = await seedOwner(token);

    const disabledRes = await bulk("/batches", { headers: authHeaders(token) });
    expect(disabledRes.status).toBe(404);

    setTestEnvVar("BULK_UPLOAD", "1");
    const grant = await mintGrant(ownerId);
    const enabledRes = await bulk("/batches", {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json", "x-bulk-grant": grant.id },
      body: JSON.stringify({ client_batch_key: "re-enabled", name: "Estate", country: "US", postal_code: "02144" }),
    });
    expect(enabledRes.status).toBe(201);
  });
});

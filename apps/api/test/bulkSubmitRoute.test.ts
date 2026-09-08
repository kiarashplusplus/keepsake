/**
 * `POST /api/bulk/batches/:id/submit`, `GET /api/bulk/operations/:id`,
 * `GET /api/bulk/batches/:id/operations`, `POST /api/bulk/operations/:id/retry`
 * and `DELETE /api/bulk/operations/:id` — driven entirely over HTTP, unlike
 * `bulkSubmit.test.ts`/`bulkSubmitIdempotency.test.ts`, which call
 * `startSubmission`/`runBulkOperation` directly and say so in their own
 * headers.
 *
 * Batch/item/photo setup goes through `bulkRoutes.request(...)` (no
 * `ExecutionContext` needed, same as `bulkBatches.test.ts`), but every submit/
 * operations call goes through `SELF.fetch(...)` instead: `POST .../submit`
 * and `POST .../retry` both call `c.executionCtx.waitUntil(...)`, which
 * throws "This context has no ExecutionContext" against a bare
 * `bulkRoutes.request(...)` — Hono only supplies one when the real Worker
 * fetch handler runs, which is exactly what `SELF.fetch` exercises.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BulkOperationSummary } from "@keepsake/contracts/bulk";
import { bulkRoutes } from "../src/routes/bulk.js";
import { ITEMS_PER_INVOCATION, runBulkOperation } from "../src/bulk/submit.js";
import { ulid } from "../src/lib/ids.js";
import { sha256Hex } from "../src/lib/digest.js";
import { authHeaders, fakeFile, fakeJpegBytes, freshClientIp, freshOwnerToken, readErr, readOk, seedStandardPostalCodes, setTestEnvVar, waitFor } from "./helpers.js";

const ADMIN_TOKEN = "test-admin-token-bulk-submit-route";

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

function bulkHeaders(token: string, grantId?: string): Record<string, string> {
  return {
    ...authHeaders(token),
    "Content-Type": "application/json",
    ...(grantId ? { "x-bulk-grant": grantId } : {}),
  };
}

/** Setup calls (batch/item/photo) — no `ExecutionContext` needed, so a bare
 * `bulkRoutes.request` is enough, same as `bulkBatches.test.ts`. */
async function bulk(path: string, init: RequestInit = {}): Promise<Response> {
  return bulkRoutes.request(path, init, env);
}

/** Submit/operations calls — these hit `c.executionCtx.waitUntil(...)`, so
 * they must go through the real Worker fetch handler. */
async function bulkHttp(path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`http://x/api/bulk${path}`, init);
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

const VALID_STORY = "This belonged to my grandmother, and I would love for it to find a new home.";

interface BatchBody {
  id: string;
}

interface ItemBody {
  id: string;
  client_item_id: string;
  revision: number;
}

/** A fresh owner, grant, batch, and one ready item with an attached photo —
 * the smallest fixture every test below builds on. */
async function readyFixture(): Promise<{ ownerId: string; token: string; grantId: string; batchId: string; item: ItemBody }> {
  await seedStandardPostalCodes();
  const token = freshOwnerToken();
  const ownerId = await seedOwner(token);
  const grant = await mintGrant(ownerId);

  const batch = await bulk("/batches", {
    method: "POST",
    headers: bulkHeaders(token, grant.id),
    body: JSON.stringify({ client_batch_key: `batch-${ownerId}`, name: "Estate", country: "US", postal_code: "02144" }),
  }).then((res) => readOk<BatchBody>(res));

  const item = await bulk(`/batches/${batch.id}/items/item-1`, {
    method: "PUT",
    headers: bulkHeaders(token, grant.id),
    body: JSON.stringify({ fields: { title: "A lovely teacup", story: VALID_STORY, category: "home_kitchen" } }),
  }).then((res) => readOk<ItemBody>(res));

  await bulk(`/batches/${batch.id}/photos/photo-1`, {
    method: "PUT",
    headers: { ...authHeaders(token), "x-bulk-grant": grant.id },
    body: photoForm(),
  }).then((res) => readOk(res));

  const linked = await bulk(`/batches/${batch.id}/items/item-1`, {
    method: "PUT",
    headers: bulkHeaders(token, grant.id),
    body: JSON.stringify({
      expected_revision: item.revision,
      fields: { title: "A lovely teacup", story: VALID_STORY, category: "home_kitchen" },
      photo_client_ids: ["photo-1"],
    }),
  }).then((res) => readOk<ItemBody>(res));

  return { ownerId, token, grantId: grant.id, batchId: batch.id, item: linked };
}

function validDateOfBirth(): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 30);
  return date.toISOString().slice(0, 10);
}

async function submitOnce(
  token: string,
  batchId: string,
  opKey: string,
  items: { client_item_id: string; revision: number }[],
): Promise<Response> {
  return bulkHttp(`/batches/${batchId}/submit`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ op_key: opKey, date_of_birth: validDateOfBirth(), items }),
  });
}

async function operationStatus(operationId: string): Promise<{ status: string; succeeded: number; failed: number; cursor: number }> {
  const row = await env.DB.prepare("SELECT status, succeeded, failed, cursor FROM bulk_operations WHERE id = ?")
    .bind(operationId)
    .first<{ status: string; succeeded: number; failed: number; cursor: number }>();
  if (!row) throw new Error(`operation ${operationId} not found`);
  return row;
}

async function waitForOperationDone(operationId: string): Promise<{ status: string; succeeded: number; failed: number; cursor: number }> {
  return waitFor(async () => {
    const row = await operationStatus(operationId);
    return row.status === "done" ? row : undefined;
  });
}

describe("bulk submission routes", () => {
  it("202s with the operation summary shape, and the eager attempt actually publishes", async () => {
    const { token, batchId, item } = await readyFixture();

    const res = await submitOnce(token, batchId, "submit-1", [{ client_item_id: item.client_item_id, revision: item.revision }]);
    expect(res.status).toBe(202);
    const operation = await readOk<BulkOperationSummary>(res);
    expect(operation.batch_id).toBe(batchId);
    expect(operation.kind).toBe("submit");
    expect(operation.total).toBe(1);
    expect(["queued", "running", "done"]).toContain(operation.status);
    expect(operation.succeeded).toBeGreaterThanOrEqual(0);
    expect(operation.failed).toBeGreaterThanOrEqual(0);
    expect(operation.finished_at === null || typeof operation.finished_at === "number").toBe(true);

    const done = await waitForOperationDone(operation.id);
    expect(done.succeeded).toBe(1);
    expect(done.failed).toBe(0);

    const itemRow = await env.DB.prepare("SELECT listing_id FROM upload_batch_items WHERE id = ?")
      .bind(item.id)
      .first<{ listing_id: string | null }>();
    expect(itemRow?.listing_id).not.toBeNull();
  });

  it("a replayed op_key returns the same operation, never a second one", async () => {
    const { token, batchId, item } = await readyFixture();
    const items = [{ client_item_id: item.client_item_id, revision: item.revision }];

    const first = await submitOnce(token, batchId, "replay-key", items).then((res) => readOk<BulkOperationSummary>(res));
    const second = await submitOnce(token, batchId, "replay-key", items).then((res) => readOk<BulkOperationSummary>(res));
    expect(second.id).toBe(first.id);

    await waitForOperationDone(first.id);

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM bulk_operations WHERE batch_id = ? AND op_key = ?")
      .bind(batchId, "replay-key")
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("409s when the named item moved since it was reviewed", async () => {
    const { token, grantId, batchId, item } = await readyFixture();

    // Bumps the item's revision without changing what's being submitted —
    // just enough to make the reviewed revision stale.
    await bulk(`/batches/${batchId}/items/${item.client_item_id}`, {
      method: "PUT",
      headers: bulkHeaders(token, grantId),
      body: JSON.stringify({ expected_revision: item.revision, fields: { title: "Edited after review", story: VALID_STORY, category: "home_kitchen" } }),
    }).then((res) => readOk(res));

    const res = await submitOnce(token, batchId, "stale-key", [{ client_item_id: item.client_item_id, revision: item.revision }]);
    expect(res.status).toBe(409);
    const error = await readErr(res);
    expect(error.code).toBe("conflict");
  });

  it("409s when the same op_key arrives with a different selection", async () => {
    const { token, grantId, batchId, item } = await readyFixture();

    const second = await bulk(`/batches/${batchId}/items/item-2`, {
      method: "PUT",
      headers: bulkHeaders(token, grantId),
      body: JSON.stringify({ fields: { title: "A second thing", story: VALID_STORY, category: "home_kitchen" } }),
    }).then((res) => readOk<ItemBody>(res));

    const first = await submitOnce(token, batchId, "dup-key", [{ client_item_id: item.client_item_id, revision: item.revision }]);
    expect(first.status).toBe(202);

    const changed = await submitOnce(token, batchId, "dup-key", [{ client_item_id: second.client_item_id, revision: second.revision }]);
    expect(changed.status).toBe(409);
    const error = await readErr(changed);
    expect(error.code).toBe("conflict");
  });

  it("every new route answers a different owner's ids with 404, never 403", async () => {
    const { token, batchId, item } = await readyFixture();
    const operation = await submitOnce(token, batchId, "owner-scope-key", [{ client_item_id: item.client_item_id, revision: item.revision }]).then(
      (res) => readOk<BulkOperationSummary>(res),
    );
    await waitForOperationDone(operation.id);

    const strangerToken = freshOwnerToken();
    await seedOwner(strangerToken);
    const strangerHeaders = authHeaders(strangerToken);

    const submitAsStranger = await submitOnce(strangerToken, batchId, "stranger-key", [{ client_item_id: item.client_item_id, revision: item.revision }]);
    expect(submitAsStranger.status).toBe(404);

    const getOp = await bulkHttp(`/operations/${operation.id}`, { headers: strangerHeaders });
    expect(getOp.status).toBe(404);

    const listOps = await bulkHttp(`/batches/${batchId}/operations`, { headers: strangerHeaders });
    expect(listOps.status).toBe(404);

    const retry = await bulkHttp(`/operations/${operation.id}/retry`, { method: "POST", headers: strangerHeaders });
    expect(retry.status).toBe(404);

    const cancel = await bulkHttp(`/operations/${operation.id}`, { method: "DELETE", headers: strangerHeaders });
    expect(cancel.status).toBe(404);

    // Sanity: the owner's own token still sees it — 404 above is ownership
    // scoping, not the id being wrong.
    const ownGet = await bulkHttp(`/operations/${operation.id}`, { headers: authHeaders(token) });
    expect(ownGet.status).toBe(200);
  });

  it("retry re-queues a still-failing item and is idempotent — the succeeded item's listing never doubles", async () => {
    const { token, grantId, batchId, item: okItem } = await readyFixture();

    // A second item with no story at all — permanently invalid, so it fails
    // the exact same way on every attempt, forever, which is what makes it
    // useful for an idempotency check: the end state after any number of
    // retries must be identical.
    const badItem = await bulk(`/batches/${batchId}/items/item-bad`, {
      method: "PUT",
      headers: bulkHeaders(token, grantId),
      body: JSON.stringify({ fields: { title: "Incomplete", category: "home_kitchen" } }),
    }).then((res) => readOk<ItemBody>(res));

    const operation = await submitOnce(token, batchId, "retry-key", [
      { client_item_id: okItem.client_item_id, revision: okItem.revision },
      { client_item_id: badItem.client_item_id, revision: badItem.revision },
    ]).then((res) => readOk<BulkOperationSummary>(res));

    const firstDone = await waitForOperationDone(operation.id);
    expect(firstDone.succeeded).toBe(1);
    expect(firstDone.failed).toBe(1);

    const okListingAfterFirst = await env.DB.prepare("SELECT listing_id FROM upload_batch_items WHERE id = ?")
      .bind(okItem.id)
      .first<{ listing_id: string | null }>();
    expect(okListingAfterFirst?.listing_id).not.toBeNull();

    for (let attempt = 0; attempt < 2; attempt++) {
      const retryRes = await bulkHttp(`/operations/${operation.id}/retry`, { method: "POST", headers: authHeaders(token) });
      expect(retryRes.status).toBe(200);
      await readOk<BulkOperationSummary>(retryRes);

      const settled = await waitForOperationDone(operation.id);
      expect(settled.succeeded).toBe(1);
      expect(settled.failed).toBe(1);

      const okListing = await env.DB.prepare("SELECT listing_id FROM upload_batch_items WHERE id = ?")
        .bind(okItem.id)
        .first<{ listing_id: string | null }>();
      // Never a different listing, never a second one — the same id every
      // time, across any number of retries.
      expect(okListing?.listing_id).toBe(okListingAfterFirst?.listing_id);

      const listingCount = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM listings WHERE id IN (SELECT listing_id FROM upload_batch_items WHERE id = ?)",
      )
        .bind(okItem.id)
        .first<{ n: number }>();
      expect(listingCount?.n).toBe(1);

      const badRow = await env.DB.prepare("SELECT state, listing_id FROM upload_batch_items WHERE id = ?")
        .bind(badItem.id)
        .first<{ state: string; listing_id: string | null }>();
      expect(badRow?.state).toBe("failed");
      expect(badRow?.listing_id).toBeNull();
    }
  });

  it("retrying a fully-succeeded operation is a no-op", async () => {
    const { token, batchId, item } = await readyFixture();
    const operation = await submitOnce(token, batchId, "all-good-key", [{ client_item_id: item.client_item_id, revision: item.revision }]).then(
      (res) => readOk<BulkOperationSummary>(res),
    );
    const done = await waitForOperationDone(operation.id);
    expect(done.succeeded).toBe(1);
    expect(done.failed).toBe(0);

    const retryRes = await bulkHttp(`/operations/${operation.id}/retry`, { method: "POST", headers: authHeaders(token) });
    expect(retryRes.status).toBe(200);
    const retried = await readOk<BulkOperationSummary>(retryRes);
    expect(retried.status).toBe("done");
    expect(retried.succeeded).toBe(1);
    expect(retried.failed).toBe(0);
  });

  it("cancel stops unstarted work but never withdraws a listing already created", async () => {
    const { token, grantId, batchId } = await readyFixture();

    // `readyFixture` already made item-1; add enough more ready items that
    // one eager `ITEMS_PER_INVOCATION`-bounded pass cannot finish them all —
    // the partial state is the point of this test.
    const totalItems = ITEMS_PER_INVOCATION + 1;
    const selection: { client_item_id: string; revision: number }[] = [];
    for (let i = 1; i <= totalItems; i++) {
      const clientId = `cancel-item-${i}`;
      const created = await bulk(`/batches/${batchId}/items/${clientId}`, {
        method: "PUT",
        headers: bulkHeaders(token, grantId),
        body: JSON.stringify({ fields: { title: `Object ${i}`, story: VALID_STORY, category: "home_kitchen" } }),
      }).then((res) => readOk<ItemBody>(res));

      await bulk(`/batches/${batchId}/photos/cancel-photo-${i}`, {
        method: "PUT",
        headers: { ...authHeaders(token), "x-bulk-grant": grantId },
        body: photoForm(),
      }).then((res) => readOk(res));

      const withPhoto = await bulk(`/batches/${batchId}/items/${clientId}`, {
        method: "PUT",
        headers: bulkHeaders(token, grantId),
        body: JSON.stringify({
          expected_revision: created.revision,
          fields: { title: `Object ${i}`, story: VALID_STORY, category: "home_kitchen" },
          photo_client_ids: [`cancel-photo-${i}`],
        }),
      }).then((res) => readOk<ItemBody>(res));

      selection.push({ client_item_id: clientId, revision: withPhoto.revision });
    }

    const operation = await submitOnce(token, batchId, "cancel-key", selection).then((res) => readOk<BulkOperationSummary>(res));

    // The eager attempt is bounded to `ITEMS_PER_INVOCATION` — wait for
    // exactly that many to checkpoint, then stop: nothing else drives this
    // operation forward without another `runBulkOperation` call (no cron
    // runs in this suite).
    const partial = await waitFor(async () => {
      const row = await operationStatus(operation.id);
      return row.cursor >= ITEMS_PER_INVOCATION ? row : undefined;
    });
    expect(partial.status).toBe("queued");
    expect(partial.cursor).toBe(ITEMS_PER_INVOCATION);
    expect(partial.succeeded).toBe(ITEMS_PER_INVOCATION);

    const doneItemIds = await env.DB.prepare(
      "SELECT id, listing_id FROM upload_batch_items WHERE batch_id = ? AND client_item_id LIKE 'cancel-item-%' AND listing_id IS NOT NULL",
    )
      .bind(batchId)
      .all<{ id: string; listing_id: string }>();
    expect(doneItemIds.results.length).toBe(ITEMS_PER_INVOCATION);
    const listingIdsBeforeCancel = new Set(doneItemIds.results.map((row) => row.listing_id));

    const cancelRes = await bulkHttp(`/operations/${operation.id}`, { method: "DELETE", headers: authHeaders(token) });
    expect(cancelRes.status).toBe(200);
    const cancelBody = await readOk<{ operation: BulkOperationSummary; listing_ids: string[] }>(cancelRes);
    expect(cancelBody.operation.status).toBe("cancelled");
    expect(new Set(cancelBody.listing_ids)).toEqual(listingIdsBeforeCancel);

    // The one item the eager pass never reached goes back to `editing`
    // rather than being stuck reading `queued` forever, and never gets a
    // listing.
    const untouched = await env.DB.prepare(
      "SELECT state, listing_id FROM upload_batch_items WHERE batch_id = ? AND client_item_id LIKE 'cancel-item-%' AND listing_id IS NULL",
    )
      .bind(batchId)
      .all<{ state: string; listing_id: string | null }>();
    expect(untouched.results.length).toBe(1);
    expect(untouched.results[0]?.state).toBe("editing");

    // A further attempt to run the (now cancelled) operation must not
    // resurrect it or touch anything else.
    await runBulkOperation(env, operation.id);
    const afterAnotherRun = await operationStatus(operation.id);
    expect(afterAnotherRun.status).toBe("cancelled");
    expect(afterAnotherRun.cursor).toBe(ITEMS_PER_INVOCATION);

    const stillListingCount = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM upload_batch_items WHERE batch_id = ? AND client_item_id LIKE 'cancel-item-%' AND listing_id IS NOT NULL",
    )
      .bind(batchId)
      .first<{ n: number }>();
    expect(stillListingCount?.n).toBe(ITEMS_PER_INVOCATION);
  });

  it("submit on an unknown or someone else's batch id is 404, not 500 or 403", async () => {
    const { token } = await readyFixture();
    const res = await submitOnce(token, "not-a-real-batch", "no-batch-key", [{ client_item_id: "item-1", revision: 1 }]);
    expect(res.status).toBe(404);
    const error = await readErr(res);
    expect(error.code).toBe("not_found");
  });
});

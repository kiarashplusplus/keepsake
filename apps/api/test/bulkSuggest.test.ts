/**
 * `POST /batches/:id/photos/:clientPhotoId/suggest` — the batch workspace's
 * cover suggestion. Three things this file exists to prove, each one a claim
 * `routes/bulk.ts`'s doc comment on the route makes:
 *
 *  1. It reuses `suggestFromPhoto` and returns the exact `{ suggestion }`
 *     shape `POST /api/photos/:id/suggest` does (`suggest.test.ts` already
 *     covers that function's own parse/retry behaviour in depth, so this
 *     file does not re-derive it).
 *  2. Admission is a guarded D1 decrement on `bulk_grants.suggestions_remaining`
 *     — exact, and never the give flow's per-IP KV `suggest` budget.
 *  3. The *global* `SUGGEST_DAILY_BUDGET` ceiling still applies on top,
 *     deliberately, because it protects account-level AI spend rather than
 *     rationing one caller.
 *
 * Lookup/ownership (owner- and batch-scoped, 404 never 403) mirrors
 * `bulkOwnership.test.ts`'s coverage of the sibling routes; this file adds
 * the one case specific to this route (a photo id that exists but isn't in
 * *this* batch's tray).
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bulkRoutes } from "../src/routes/bulk.js";
import { MODELS } from "../src/models.js";
import { todayISO } from "../src/moderation/budget.js";
import { ulid } from "../src/lib/ids.js";
import { sha256Hex } from "../src/lib/digest.js";
import { authHeaders, fakeFile, fakeJpegBytes, freshClientIp, freshOwnerToken, readErr, readOk, seedStandardPostalCodes, setTestEnvVar } from "./helpers.js";

const ADMIN_TOKEN = "test-admin-token-bulk-suggest";

interface SuggestResponseBody {
  suggestion: { subject: string; title: string; category: string; condition: string; aspects: { name: string; value: string }[] } | null;
}

interface GrantSummary {
  id: string;
  suggestions_remaining: number;
}

async function seedOwner(token: string): Promise<string> {
  const id = ulid();
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  await env.DB.prepare("INSERT INTO owners (id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)")
    .bind(id, tokenHash, now, now)
    .run();
  return id;
}

async function mintGrant(ownerId: string, extra: { items?: number; photos?: number; suggestions?: number } = {}): Promise<GrantSummary> {
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

async function putPhoto(batchId: string, clientPhotoId: string, token: string, grantId: string): Promise<Response> {
  return bulk(`/batches/${batchId}/photos/${clientPhotoId}`, {
    method: "PUT",
    headers: { ...authHeaders(token), "x-bulk-grant": grantId },
    body: photoForm(),
  });
}

async function suggestFor(batchId: string, clientPhotoId: string, token: string, grantId?: string): Promise<Response> {
  return bulk(`/batches/${batchId}/photos/${clientPhotoId}/suggest`, {
    method: "POST",
    headers: bulkHeaders(token, grantId),
  });
}

/** Installs a fake `env.AI.run` that only answers `MODELS.imageVision` calls,
 * counting invocations — mirrors `suggest.test.ts`'s `mockSuggestAi`. Used
 * only by the tests below that need to observe *whether* the model was
 * called, not by the happy-path tests (those run under the suite's default
 * `MOCK_AI=1`, same as every other bulk test file). */
function mockSuggestAi(handler: (callIndex: number) => unknown): { callCount: () => number } {
  let callIndex = 0;
  env.AI.run = (async (model: string) => {
    if (model !== MODELS.imageVision) throw new Error(`mockSuggestAi: unexpected model ${model}`);
    const result = handler(callIndex);
    callIndex += 1;
    return result;
  }) as unknown as Ai["run"];
  return { callCount: () => callIndex };
}

async function resetGlobalSuggestBudget(): Promise<void> {
  await env.KV.delete(`budget:suggest:${todayISO()}`);
}

const VALID_SUGGESTION_JSON = JSON.stringify({
  subject: "a stoneware mug",
  title: "Chipped stoneware mug",
  category: "home_kitchen",
  condition: "glaze worn at the rim",
  aspects: [{ name: "object", value: "mug" }],
});

describe("POST /batches/:id/photos/:clientPhotoId/suggest", () => {
  it("happy path: returns the same { suggestion } shape as the give flow's route, and spends one suggestion", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const ownerId = await seedOwner(token);
    const grant = await mintGrant(ownerId, { suggestions: 2 });
    const batch = await createBatch(token, grant.id, "happy-path");
    await putPhoto(batch.id, "p1", token, grant.id);

    const res = await suggestFor(batch.id, "p1", token, grant.id);
    expect(res.status).toBe(200);
    const body = await readOk<SuggestResponseBody>(res);
    // MOCK_AI=1 (the suite default) returns the fixed mock suggestion —
    // `suggest.test.ts` already proves the model reply is validated against
    // `PhotoSuggestionSchema` on the shared code path this route reuses.
    expect(body.suggestion).not.toBeNull();
    expect(body.suggestion?.title).toBe("Blue ceramic mug");
    expect(body.suggestion?.category).toBe("home_kitchen");

    const grantRow = await env.DB.prepare("SELECT suggestions_remaining FROM bulk_grants WHERE id = ?")
      .bind(grant.id)
      .first<{ suggestions_remaining: number }>();
    expect(grantRow?.suggestions_remaining).toBe(1);
  });

  it("the suggestion allowance is exact: a grant with 2 lets exactly 2 through and 429s the third", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const ownerId = await seedOwner(token);
    const grant = await mintGrant(ownerId, { photos: 3, suggestions: 2 });
    const batch = await createBatch(token, grant.id, "allowance");
    await putPhoto(batch.id, "p1", token, grant.id);
    await putPhoto(batch.id, "p2", token, grant.id);
    await putPhoto(batch.id, "p3", token, grant.id);

    const first = await suggestFor(batch.id, "p1", token, grant.id);
    expect(first.status).toBe(200);
    const second = await suggestFor(batch.id, "p2", token, grant.id);
    expect(second.status).toBe(200);

    const third = await suggestFor(batch.id, "p3", token, grant.id);
    expect(third.status).toBe(429);
    const err = await readErr(third);
    expect(err.code).toBe("rate_limited");

    // Nothing left to give back, and the counter never goes negative.
    const grantRow = await env.DB.prepare("SELECT suggestions_remaining FROM bulk_grants WHERE id = ?")
      .bind(grant.id)
      .first<{ suggestions_remaining: number }>();
    expect(grantRow?.suggestions_remaining).toBe(0);
  });

  it("an exhausted grant refuses before the AI is ever called", async () => {
    await seedStandardPostalCodes();
    const mock = mockSuggestAi(() => VALID_SUGGESTION_JSON);
    const token = freshOwnerToken();
    const ownerId = await seedOwner(token);
    // `AdminMintBulkGrantInput.suggestions` is `.positive()` — a grant can't
    // be minted with zero, so exhaustion is reached the same way it would in
    // production: mint one, then spend it directly (mirrors
    // `bulkAdmission.test.ts`'s use of a raw `UPDATE`/`INSERT` for a state
    // an admin route can't produce).
    const grant = await mintGrant(ownerId, { suggestions: 1 });
    const batch = await createBatch(token, grant.id, "exhausted");
    await putPhoto(batch.id, "p1", token, grant.id);
    await env.DB.prepare("UPDATE bulk_grants SET suggestions_remaining = 0 WHERE id = ?").bind(grant.id).run();

    const res = await suggestFor(batch.id, "p1", token, grant.id);
    expect(res.status).toBe(429);
    const err = await readErr(res);
    expect(err.code).toBe("rate_limited");
    expect(err.message).toMatch(/no suggestions left/);
    expect(mock.callCount()).toBe(0);
  });

  it("403s with no grant header, same as every other write route in this router", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const ownerId = await seedOwner(token);
    const grant = await mintGrant(ownerId, { suggestions: 1 });
    const batch = await createBatch(token, grant.id, "no-grant-header");
    await putPhoto(batch.id, "p1", token, grant.id);

    const res = await suggestFor(batch.id, "p1", token);
    expect(res.status).toBe(403);
  });

  it("404s for a batch that belongs to someone else, not 403", async () => {
    await seedStandardPostalCodes();
    const ownerA = freshOwnerToken();
    const ownerAId = await seedOwner(ownerA);
    const grantA = await mintGrant(ownerAId, { suggestions: 1 });
    const batch = await createBatch(ownerA, grantA.id, "owner-a-batch");
    await putPhoto(batch.id, "p1", ownerA, grantA.id);

    const ownerB = freshOwnerToken();
    const ownerBId = await seedOwner(ownerB);
    const grantB = await mintGrant(ownerBId, { suggestions: 1 });

    const res = await suggestFor(batch.id, "p1", ownerB, grantB.id);
    expect(res.status).toBe(404);
    const err = await readErr(res);
    expect(err.code).toBe("not_found");
  });

  it("404s for a client photo id that isn't in this batch's tray", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const ownerId = await seedOwner(token);
    const grant = await mintGrant(ownerId, { suggestions: 1 });
    const batch = await createBatch(token, grant.id, "no-such-photo");

    const res = await suggestFor(batch.id, "nonexistent", token, grant.id);
    expect(res.status).toBe(404);
  });

  it("the global SUGGEST_DAILY_BUDGET still refuses a bulk caller, and nothing is charged to the grant when it does", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const ownerId = await seedOwner(token);
    const grant = await mintGrant(ownerId, { suggestions: 5 });
    const batch = await createBatch(token, grant.id, "global-budget");
    await putPhoto(batch.id, "p1", token, grant.id);

    setTestEnvVar("SUGGEST_DAILY_BUDGET", "0");
    try {
      const res = await suggestFor(batch.id, "p1", token, grant.id);
      expect(res.status).toBe(429);
      const err = await readErr(res);
      expect(err.code).toBe("rate_limited");
      expect(typeof err.retryAfter).toBe("number");

      // The global ceiling refused before the D1 debit ever ran.
      const grantRow = await env.DB.prepare("SELECT suggestions_remaining FROM bulk_grants WHERE id = ?")
        .bind(grant.id)
        .first<{ suggestions_remaining: number }>();
      expect(grantRow?.suggestions_remaining).toBe(5);
    } finally {
      setTestEnvVar("SUGGEST_DAILY_BUDGET", "1000");
    }
  });

  it("the give flow's per-IP SUGGEST_IP_DAILY_BUDGET does not ration this route: one IP, one grant, many calls past the per-IP number", async () => {
    await seedStandardPostalCodes();
    await resetGlobalSuggestBudget();
    // A ceiling so low that two calls from what would be one IP under the
    // give-flow route would already be refused there — proving this route
    // ignores it entirely, not just that it's set generously.
    setTestEnvVar("SUGGEST_IP_DAILY_BUDGET", "1");
    try {
      const token = freshOwnerToken();
      const ownerId = await seedOwner(token);
      const grant = await mintGrant(ownerId, { suggestions: 3 });
      const batch = await createBatch(token, grant.id, "per-ip-ignored");
      await putPhoto(batch.id, "p1", token, grant.id);
      await putPhoto(batch.id, "p2", token, grant.id);
      await putPhoto(batch.id, "p3", token, grant.id);

      const first = await suggestFor(batch.id, "p1", token, grant.id);
      const second = await suggestFor(batch.id, "p2", token, grant.id);
      const third = await suggestFor(batch.id, "p3", token, grant.id);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(third.status).toBe(200);
    } finally {
      setTestEnvVar("SUGGEST_IP_DAILY_BUDGET", "30");
    }
  });
});

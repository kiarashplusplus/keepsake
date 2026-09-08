/**
 * `POST /batches/:id/photos/:clientPhotoId/suggest` — the batch workspace's
 * cover suggestion. Three things this file exists to prove, each one a claim
 * `routes/bulk.ts`'s doc comment on the route makes:
 *
 *  1. It reuses `suggestFromPhoto` and returns the exact `{ suggestion }`
 *     shape `POST /api/photos/:id/suggest` does (`suggest.test.ts` already
 *     covers that function's own parse/retry behaviour in depth, so this
 *     file does not re-derive it).
 *  2. The ceiling is a guarded D1 upsert on
 *     `bulk_owner_usage.suggestions_used` — exact, and never the give flow's
 *     per-IP KV `suggest` budget.
 *  3. The *global* `SUGGEST_DAILY_BUDGET` ceiling still applies on top,
 *     deliberately, because it protects account-level AI spend rather than
 *     rationing one caller.
 *
 * Lookup/ownership (owner- and batch-scoped, 404 never 403) mirrors
 * `bulkOwnership.test.ts`'s coverage of the sibling routes; this file adds
 * the one case specific to this route (a photo id that exists but isn't in
 * *this* batch's tray).
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bulkRoutes } from "../src/routes/bulk.js";
import { MODELS } from "../src/models.js";
import { todayISO } from "../src/moderation/budget.js";
import { ulid } from "../src/lib/ids.js";
import { sha256Hex } from "../src/lib/digest.js";
import { authHeaders, fakeFile, fakeJpegBytes, freshOwnerToken, readErr, readOk, seedStandardPostalCodes, setTestEnvVar } from "./helpers.js";

interface SuggestResponseBody {
  suggestion: { subject: string; title: string; category: string; condition: string; aspects: { name: string; value: string }[] } | null;
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

function bulkHeaders(token: string): Record<string, string> {
  return { ...authHeaders(token), "Content-Type": "application/json" };
}

/** This owner's `suggestions_used` for today, or 0 before any row exists. */
async function suggestionsUsed(ownerId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT suggestions_used FROM bulk_owner_usage WHERE owner_id = ? AND day = ?")
    .bind(ownerId, todayISO())
    .first<{ suggestions_used: number }>();
  return row?.suggestions_used ?? 0;
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

async function putPhoto(batchId: string, clientPhotoId: string, token: string): Promise<Response> {
  return bulk(`/batches/${batchId}/photos/${clientPhotoId}`, {
    method: "PUT",
    headers: authHeaders(token),
    body: photoForm(),
  });
}

async function suggestFor(batchId: string, clientPhotoId: string, token: string): Promise<Response> {
  return bulk(`/batches/${batchId}/photos/${clientPhotoId}/suggest`, {
    method: "POST",
    headers: bulkHeaders(token),
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
    const batch = await createBatch(token, "happy-path");
    await putPhoto(batch.id, "p1", token);

    const res = await suggestFor(batch.id, "p1", token);
    expect(res.status).toBe(200);
    const body = await readOk<SuggestResponseBody>(res);
    // MOCK_AI=1 (the suite default) returns the fixed mock suggestion —
    // `suggest.test.ts` already proves the model reply is validated against
    // `PhotoSuggestionSchema` on the shared code path this route reuses.
    expect(body.suggestion).not.toBeNull();
    expect(body.suggestion?.title).toBe("Blue ceramic mug");
    expect(body.suggestion?.category).toBe("home_kitchen");

    expect(await suggestionsUsed(ownerId)).toBe(1);
  });

  it("the suggestion allowance is exact: a daily ceiling of 2 lets exactly 2 through and 429s the third", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const ownerId = await seedOwner(token);
    setTestEnvVar("BULK_OWNER_DAILY_SUGGESTIONS", "2");
    const batch = await createBatch(token, "allowance");
    await putPhoto(batch.id, "p1", token);
    await putPhoto(batch.id, "p2", token);
    await putPhoto(batch.id, "p3", token);

    const first = await suggestFor(batch.id, "p1", token);
    expect(first.status).toBe(200);
    const second = await suggestFor(batch.id, "p2", token);
    expect(second.status).toBe(200);

    try {
      const third = await suggestFor(batch.id, "p3", token);
      expect(third.status).toBe(429);
      const err = await readErr(third);
      expect(err.code).toBe("rate_limited");
      expect(err.retryAfter).toBeDefined();

      // The counter stopped exactly at the ceiling — the refused third
      // call charged nothing.
      expect(await suggestionsUsed(ownerId)).toBe(2);
    } finally {
      setTestEnvVar("BULK_OWNER_DAILY_SUGGESTIONS", "225");
    }
  });

  it("a spent ceiling refuses before the AI is ever called — a vision call costs real money", async () => {
    await seedStandardPostalCodes();
    const mock = mockSuggestAi(() => VALID_SUGGESTION_JSON);
    const token = freshOwnerToken();
    const ownerId = await seedOwner(token);
    const batch = await createBatch(token, "exhausted");
    await putPhoto(batch.id, "p1", token);
    // Today's row written straight to the ceiling — the state a giver
    // reaches after a long sitting, without spending the calls to get there.
    await env.DB.prepare(
      `INSERT INTO bulk_owner_usage (owner_id, day, suggestions_used) VALUES (?, ?, 225)
         ON CONFLICT(owner_id, day) DO UPDATE SET suggestions_used = 225`,
    )
      .bind(ownerId, todayISO())
      .run();

    const res = await suggestFor(batch.id, "p1", token);
    expect(res.status).toBe(429);
    const err = await readErr(res);
    expect(err.code).toBe("rate_limited");
    expect(err.message).toMatch(/suggestion limit/);
    expect(mock.callCount()).toBe(0);
  });

  it("404s for a batch that belongs to someone else, not 403", async () => {
    await seedStandardPostalCodes();
    const ownerA = freshOwnerToken();
    await seedOwner(ownerA);
    const batch = await createBatch(ownerA, "owner-a-batch");
    await putPhoto(batch.id, "p1", ownerA);

    const ownerB = freshOwnerToken();
    await seedOwner(ownerB);

    const res = await suggestFor(batch.id, "p1", ownerB);
    expect(res.status).toBe(404);
    const err = await readErr(res);
    expect(err.code).toBe("not_found");
  });

  it("404s for a client photo id that isn't in this batch's tray", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    await seedOwner(token);
    const batch = await createBatch(token, "no-such-photo");

    const res = await suggestFor(batch.id, "nonexistent", token);
    expect(res.status).toBe(404);
  });

  it("the global SUGGEST_DAILY_BUDGET still refuses a bulk caller, and nothing is charged to the owner when it does", async () => {
    await seedStandardPostalCodes();
    const token = freshOwnerToken();
    const ownerId = await seedOwner(token);
    const batch = await createBatch(token, "global-budget");
    await putPhoto(batch.id, "p1", token);

    setTestEnvVar("SUGGEST_DAILY_BUDGET", "0");
    try {
      const res = await suggestFor(batch.id, "p1", token);
      expect(res.status).toBe(429);
      const err = await readErr(res);
      expect(err.code).toBe("rate_limited");
      expect(typeof err.retryAfter).toBe("number");

      // The global ceiling refused before the D1 debit ever ran.
      expect(await suggestionsUsed(ownerId)).toBe(0);
    } finally {
      setTestEnvVar("SUGGEST_DAILY_BUDGET", "1000");
    }
  });

  it("the give flow's per-IP SUGGEST_IP_DAILY_BUDGET does not ration this route: one IP, one owner, many calls past the per-IP number", async () => {
    await seedStandardPostalCodes();
    await resetGlobalSuggestBudget();
    // A ceiling so low that two calls from what would be one IP under the
    // give-flow route would already be refused there — proving this route
    // ignores it entirely, not just that it's set generously.
    setTestEnvVar("SUGGEST_IP_DAILY_BUDGET", "1");
    try {
      const token = freshOwnerToken();
      await seedOwner(token);
      const batch = await createBatch(token, "per-ip-ignored");
      await putPhoto(batch.id, "p1", token);
      await putPhoto(batch.id, "p2", token);
      await putPhoto(batch.id, "p3", token);

      const first = await suggestFor(batch.id, "p1", token);
      const second = await suggestFor(batch.id, "p2", token);
      const third = await suggestFor(batch.id, "p3", token);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(third.status).toBe(200);
    } finally {
      setTestEnvVar("SUGGEST_IP_DAILY_BUDGET", "30");
    }
  });
});

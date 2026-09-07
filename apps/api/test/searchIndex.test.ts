/**
 * Issue #208 — the readers of `listings.vector_indexed_at`.
 *
 * #180 added that column so "this listing has no vector for its current
 * text" would be a queryable fact rather than silence, and then nothing
 * queried it: no Observatory panel, no digest alert, no cron. A signal
 * nobody looks at is the same defect as a panel that cannot tell "I did not
 * look" from "I looked and saw nothing" — AGENTS.md's own framing, and #16's
 * precedent (cron status "computed correctly but never shown").
 *
 * So these tests are about the three readers, not about the writer, which
 * `reembed`'s own tests already cover.
 */
import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Observatory } from "@keepsake/contracts/observatory";
import { MODELS } from "../src/models.js";
import { searchIndexRetry } from "../src/cron/searchIndexRetry.js";
import { buildDailyReport } from "../src/report/daily.js";
import { insertApprovedListing, insertOwner, installFakeVectorize, readOk, setTestEnvVar } from "./helpers.js";

const ADMIN_TOKEN = "test-admin-token-search-index";

/** Counts embedding calls, so a test can say "no call was spent" rather than
 * only "no vector was written" — the distinction `adminResuggest.test.ts` and
 * `backfillAspects.test.ts` both draw. A fixed vector is enough; nothing here
 * asserts anything about vector space. */
let embeddingCallCount = 0;

function mockEmbeddingAi(): void {
  // `MOCK_AI` short-circuits `embed()` to `null` before it ever reaches
  // `env.AI.run`, which would leave every listing here recording NULL and
  // make these assertions pass or fail for a reason that has nothing to do
  // with the retry. Off, so the real call path runs into the stub below —
  // the same choice `adminResuggest.test.ts` and `backfillAspects.test.ts`
  // make, and for the same reason.
  setTestEnvVar("MOCK_AI", "0");
  embeddingCallCount = 0;
  const run = async (model: string) => {
    if (model !== MODELS.embedding) throw new Error(`mockEmbeddingAi: unexpected model ${model}`);
    embeddingCallCount += 1;
    return { shape: [1, 3], data: [[0.1, 0.2, 0.3]] };
  };
  env.AI.run = run as unknown as Ai["run"];
}
const HOUR_MS = 60 * 60 * 1000;

function adminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" };
}

async function getObservatory(): Promise<Observatory> {
  return readOk<Observatory>(await SELF.fetch("http://x/api/admin/observatory", { headers: adminHeaders() }));
}

/** Every listing this file's assertions count. Other files in this worker
 * share the same D1, so each test works from a clean slate rather than
 * asserting on a total it does not own. */
async function clearListings(): Promise<void> {
  await env.DB.prepare("DELETE FROM listings").run();
}

async function seedListing(options: { indexedAt: number | null; updatedAt?: number; status?: string }): Promise<string> {
  const ownerId = await insertOwner();
  const id = await insertApprovedListing({ ownerId });
  await env.DB.prepare("UPDATE listings SET vector_indexed_at = ?, updated_at = ?, status = ? WHERE id = ?")
    .bind(options.indexedAt, options.updatedAt ?? Date.now(), options.status ?? "approved", id)
    .run();
  return id;
}

describe("the Observatory's search-index panel (#208)", () => {
  beforeEach(async () => {
    setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
    // `vitest.config.ts` pins SEMANTIC_SEARCH to "0" for the whole suite, so
    // the enabled shape has to opt in — and restore the "0", or every later
    // file in this worker inherits a flag it never asked for.
    setTestEnvVar("SEMANTIC_SEARCH", "1");
    await clearListings();
  });
  afterEach(async () => {
    setTestEnvVar("ADMIN_TOKEN", "");
    setTestEnvVar("SEMANTIC_SEARCH", "0");
    await clearListings();
  });

  it("counts approved listings with no vector, and ages the oldest", async () => {
    await seedListing({ indexedAt: Date.now() });
    await seedListing({ indexedAt: null, updatedAt: Date.now() - 3 * HOUR_MS });
    await seedListing({ indexedAt: null, updatedAt: Date.now() - 30 * HOUR_MS });

    const observatory = await getObservatory();
    const panel = observatory.app.search_index;

    expect(panel.enabled).toBe(true);
    if (!panel.enabled) return; // narrowing; the assertion above is the real check
    expect(panel.approved).toBe(3);
    expect(panel.unindexed).toBe(2);
    // The age is the verdict, per the contract's own comment: two listings
    // that failed in the last minute are the retry queue working, one that
    // has waited 30 hours is not.
    expect(panel.oldest_unindexed_age_ms).toBeGreaterThanOrEqual(30 * HOUR_MS);
    expect(panel.oldest_unindexed_age_ms).toBeLessThan(31 * HOUR_MS);
  });

  it("does not count a listing that is not approved", async () => {
    // A `pending` listing with no vector yet is the pipeline working, not a
    // fault — and re-embedding it would spend budget on text a human may
    // still reject.
    await seedListing({ indexedAt: null, status: "pending" });

    const panel = (await getObservatory()).app.search_index;
    if (!panel.enabled) throw new Error("expected the panel to be enabled");
    expect(panel.approved).toBe(0);
    expect(panel.unindexed).toBe(0);
    expect(panel.oldest_unindexed_age_ms).toBeNull();
  });

  it("reports nothing at all when semantic search is switched off", async () => {
    // With the kill switch off `reembedListing` records nothing, so every
    // listing reads as un-indexed. Rendering "3 un-indexed" for a feature
    // nobody turned on is worse than rendering nothing.
    await seedListing({ indexedAt: null });
    setTestEnvVar("SEMANTIC_SEARCH", "0");
    expect((await getObservatory()).app.search_index).toEqual({ enabled: false });
  });
});

describe("the daily digest's search-index alert (#208)", () => {
  beforeEach(async () => {
    setTestEnvVar("SEMANTIC_SEARCH", "1");
    await clearListings();
  });
  afterEach(async () => {
    setTestEnvVar("SEMANTIC_SEARCH", "0");
    await clearListings();
    await env.KV.delete(`budget:embed:${new Date().toISOString().slice(0, 10)}`);
  });

  it("stays quiet while the backlog is younger than the threshold", async () => {
    // Five hours: the hourly retry has had four chances and this is still
    // ordinary. An alert here would train the reader to ignore the digest.
    await seedListing({ indexedAt: null, updatedAt: Date.now() - 5 * HOUR_MS });

    const report = await buildDailyReport(env);
    expect(report.needs_attention.map((a) => a.code)).not.toContain("search_index_backlog");
  });

  it("warns once a listing has been un-indexed past the threshold", async () => {
    await seedListing({ indexedAt: null, updatedAt: Date.now() - 7 * HOUR_MS });

    const report = await buildDailyReport(env);
    const alert = report.needs_attention.find((a) => a.code === "search_index_backlog");
    expect(alert?.severity).toBe("warning");
    expect(alert?.detail).toContain("1 of 1 approved listing(s) have no search vector");
    // The reassurance is load-bearing: #180 made an un-indexed listing still
    // findable through FTS, so this is degraded ranking, not a disappearance.
    expect(alert?.detail).toContain("full-text search");
  });

  it("names an exhausted embed budget as the cause rather than raising a second incident (#207)", async () => {
    await seedListing({ indexedAt: null, updatedAt: Date.now() - 7 * HOUR_MS });
    const today = new Date().toISOString().slice(0, 10);
    await env.KV.put(`budget:embed:${today}`, String(env.EMBED_DAILY_BUDGET ?? "2000"));

    const report = await buildDailyReport(env);
    const alert = report.needs_attention.find((a) => a.code === "search_index_backlog");
    expect(alert?.detail).toContain("embed budget is spent");
    // And the budget itself is now reported, which it never was before —
    // the day EMBED_DAILY_BUDGET ran out looked, from the digest, like
    // nothing at all.
    expect(report.budgets.embed.used).toBeGreaterThan(0);
    expect(report.needs_attention.map((a) => a.code)).toContain("budget_exhausted");
  });
});

describe("searchIndexRetry (#208)", () => {
  beforeEach(async () => {
    setTestEnvVar("SEMANTIC_SEARCH", "1");
    // The Vectorize binding has no local emulator; without this the upsert
    // fails and `reembedListing` records NULL — which would make every
    // assertion below pass or fail for the wrong reason.
    installFakeVectorize();
    mockEmbeddingAi();
    await clearListings();
  });
  afterEach(async () => {
    setTestEnvVar("SEMANTIC_SEARCH", "0");
    setTestEnvVar("MOCK_AI", "1");
    await clearListings();
  });

  it("re-embeds approved listings that have no vector", async () => {
    const stale = await seedListing({ indexedAt: null });

    await searchIndexRetry(env);

    // MOCK_AI is on in the test runtime, so the embed succeeds and the
    // column is stamped — which is the whole observable outcome: before this
    // job, a listing that failed to embed once stayed NULL forever, because
    // nothing ever looked at it again.
    const row = await env.DB.prepare("SELECT vector_indexed_at FROM listings WHERE id = ?")
      .bind(stale)
      .first<{ vector_indexed_at: number | null }>();
    expect(row?.vector_indexed_at).toEqual(expect.any(Number));
  });

  it("leaves an already-indexed listing alone", async () => {
    const indexedAt = Date.now() - 5 * HOUR_MS;
    const fresh = await seedListing({ indexedAt });

    await searchIndexRetry(env);

    const row = await env.DB.prepare("SELECT vector_indexed_at FROM listings WHERE id = ?")
      .bind(fresh)
      .first<{ vector_indexed_at: number | null }>();
    expect(row?.vector_indexed_at).toBe(indexedAt);
  });

  it("does not touch a listing that is not approved", async () => {
    const pending = await seedListing({ indexedAt: null, status: "pending" });

    await searchIndexRetry(env);

    const row = await env.DB.prepare("SELECT vector_indexed_at FROM listings WHERE id = ?")
      .bind(pending)
      .first<{ vector_indexed_at: number | null }>();
    expect(row?.vector_indexed_at).toBeNull();
  });

  it("takes at most one batch per run, newest first", async () => {
    // Six un-indexed listings against a batch of five. The oldest is the one
    // left behind, which is the documented trade: a fresh failure is the one
    // most likely to be transient and the one whose giver is still watching.
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(await seedListing({ indexedAt: null, updatedAt: Date.now() - (i + 1) * HOUR_MS }));
    }

    await searchIndexRetry(env);

    const { results } = await env.DB.prepare(
      "SELECT id, vector_indexed_at FROM listings WHERE vector_indexed_at IS NULL",
    ).all<{ id: string; vector_indexed_at: number | null }>();
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(ids[5]);
    expect(embeddingCallCount).toBe(5);
  });

  it("does nothing at all when semantic search is switched off", async () => {
    const listing = await seedListing({ indexedAt: null });
    setTestEnvVar("SEMANTIC_SEARCH", "0");
    await searchIndexRetry(env);
    const row = await env.DB.prepare("SELECT vector_indexed_at FROM listings WHERE id = ?")
      .bind(listing)
      .first<{ vector_indexed_at: number | null }>();
    expect(row?.vector_indexed_at).toBeNull();
    // Not one Workers AI call, not one budget increment: the kill switch has
    // to cost nothing, not merely produce nothing.
    expect(embeddingCallCount).toBe(0);
  });
});

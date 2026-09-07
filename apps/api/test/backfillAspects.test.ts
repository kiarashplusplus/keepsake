/**
 * Issue #37: apps/api/src/backfill/aspects.ts and its
 * `POST /api/admin/backfill-aspects` front door. `mockSuggestAi` mirrors
 * suggest.test.ts's own helper — this deliberately exercises the mocked-AI
 * call path (never MOCK_AI's canned fixture), same as that file, so a
 * per-test suggestion can be controlled precisely.
 */
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { MODELS } from "../src/models.js";
import { runAspectsBackfillBatch } from "../src/backfill/aspects.js";
import { todayISO } from "../src/moderation/budget.js";
import { insertOwner, installFakeVectorize, seedStandardPostalCodes, setTestEnvVar } from "./helpers.js";
import { ulid } from "../src/lib/ids.js";

const ADMIN_TOKEN = "test-admin-token-abcdef0123456789";

function adminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" };
}

/** Counts calls that reach the embedding model, so a test can assert "no
 * embedding call was spent" rather than only "no vector was written" — the
 * same distinction `search.test.ts` draws, and for the same reason: with
 * the flag off the point is that nothing is *called*, not merely that
 * nothing lands. */
let embeddingCallCount = 0;

function mockSuggestAi(handler: (callIndex: number) => unknown): void {
  let callIndex = 0;
  embeddingCallCount = 0;
  const run = async (model: string) => {
    // The backfill re-embeds each listing it touches (issue #38), so the
    // embedding model reaches this stub too whenever SEMANTIC_SEARCH is on.
    // A fixed vector is enough: nothing here asserts anything about vector
    // *space* — only that the call happened and the value was stored under
    // the right listing id. `search.test.ts` owns the ranking assertions.
    if (model === MODELS.embedding) {
      embeddingCallCount += 1;
      return { shape: [1, 3], data: [[0.1, 0.2, 0.3]] };
    }
    if (model !== MODELS.imageVision) {
      throw new Error(`mockSuggestAi: unexpected model ${model}`);
    }
    const result = handler(callIndex);
    callIndex += 1;
    return result;
  };
  env.AI.run = run as unknown as Ai["run"];
}

beforeEach(async () => {
  env.MOCK_AI = "0";
  // The "suggest" budget's global counter is keyed only by kind + day
  // (`budget:suggest:YYYY-MM-DD`), not by test — see `budget.test.ts`'s own
  // `freshKind()` comment on why that leaks across tests sharing one file's
  // isolated storage. That file dodges it by varying `kind`; this one can't
  // (`runAspectsBackfillBatch` always checks `"suggest"`, matching the live
  // route it shares budget with), so instead the counter is wiped clean
  // before every test.
  await env.KV.delete(`budget:suggest:${todayISO()}`);
  // `remaining` (and candidate selection order, `ORDER BY l.created_at`) is
  // a count over *every* listing in the DB, not just the ones a given test
  // inserts — and D1 state, unlike the KV wipe above, persists across tests
  // in this file. A listing another test deliberately left un-backfilled
  // (e.g. the budget-exhaustion test below) would otherwise sort ahead of
  // this test's own fixtures and pollute both `processed` and `remaining`.
  // `listings` cascades to `photos`/`listing_aspects` (0001_init.sql), so
  // this is a clean full reset, not a partial one.
  await env.DB.prepare("DELETE FROM listings").run();
});

/** Inserts a listing with exactly one photo at `position = 0` — the shape
 * `runAspectsBackfillBatch`'s candidate query requires — bypassing the
 * upload/create-listing round trip entirely, the same way
 * `helpers.ts`'s own `insertApprovedListing` skips it for listings without
 * photos. */
async function insertListingWithCoverPhoto(options: {
  ownerId: string;
  status?: string;
  aspectsBackfilledAt?: number | null;
}): Promise<string> {
  await seedStandardPostalCodes();
  const listingId = ulid();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO listings
      (id, owner_id, title, story, category, country, postal_code, place_name, admin1, lat, lng,
       status, version, created_at, updated_at, published_at, aspects_backfilled_at)
     VALUES (?, ?, 'A quiet teacup', 'This was my grandmothers favorite teacup, and I would love for it to find a new home.',
             'home_kitchen', 'US', '02144', 'Somerville', 'MA', 42.3958, -71.0967, ?, 1, ?, ?, ?, ?)`,
  )
    .bind(
      listingId,
      options.ownerId,
      options.status ?? "approved",
      now,
      now,
      options.status === "approved" ? now : null,
      options.aspectsBackfilledAt ?? null,
    )
    .run();

  const photoId = ulid();
  const fullKey = `photos/${photoId}/full.jpg`;
  const thumbKey = `photos/${photoId}/thumb.jpg`;
  await env.DB.prepare(
    `INSERT INTO photos
      (id, owner_id, listing_id, position, r2_key_full, r2_key_thumb, width, height, bytes_full, blurhash, content_type, moderation_status, created_at)
     VALUES (?, ?, ?, 0, ?, ?, 800, 600, 12345, 'LEHV6nWB2yk8pyo0adR*.7kCMdnj', 'image/jpeg', 'passed', ?)`,
  )
    .bind(photoId, options.ownerId, listingId, fullKey, thumbKey, now)
    .run();

  // `suggestFromPhoto` reads the thumb straight out of R2 (`env.BUCKET.get`)
  // before ever calling `env.AI.run` — without a real object at this key it
  // returns `{ suggestion: null, reason: "thumb_missing" }` immediately, and
  // every test in this file would silently exercise the "no suggestion"
  // path instead of the mocked-AI one it's actually meant to. `uploadPhoto`
  // (helpers.ts) does this for free via the real route; this bypasses that
  // route, so it has to do it explicitly instead.
  await env.BUCKET.put(thumbKey, new Uint8Array([0xff, 0xd8, 0xff]), { httpMetadata: { contentType: "image/jpeg" } });

  return listingId;
}

async function fetchAspects(listingId: string): Promise<{ name: string; value: string }[]> {
  const { results } = await env.DB.prepare("SELECT name, value FROM listing_aspects WHERE listing_id = ? ORDER BY position")
    .bind(listingId)
    .all<{ name: string; value: string }>();
  return results;
}

async function fetchBackfilledAt(listingId: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT aspects_backfilled_at FROM listings WHERE id = ?")
    .bind(listingId)
    .first<{ aspects_backfilled_at: number | null }>();
  return row?.aspects_backfilled_at ?? null;
}

const TEAPOT_SUGGESTION_JSON = JSON.stringify({
  subject: "a teapot",
  title: "Copper teapot",
  category: "home_kitchen",
  condition: "",
  aspects: [
    { name: "object", value: "teapot" },
    { name: "material", value: "copper" },
    { name: "era", value: "1970s" },
  ],
});

describe("runAspectsBackfillBatch", () => {
  it("persists a real suggestion's aspects and stamps aspects_backfilled_at", async () => {
    mockSuggestAi(() => TEAPOT_SUGGESTION_JSON);
    const ownerId = await insertOwner();
    const listingId = await insertListingWithCoverPhoto({ ownerId });

    const result = await runAspectsBackfillBatch(env, 5);

    expect(result.processed).toBe(1);
    expect(result.withAspects).toBe(1);
    expect(result.withoutAspects).toBe(0);
    expect(result.budgetExhausted).toBe(false);
    expect(result.remaining).toBe(0);

    expect(await fetchAspects(listingId)).toEqual([
      { name: "object", value: "teapot" },
      { name: "material", value: "copper" },
      { name: "era", value: "1970s" },
    ]);
    expect(await fetchBackfilledAt(listingId)).not.toBeNull();
  });

  // The core correctness requirement (see aspects.ts's header comment): a
  // legitimate "the model found nothing" answer must still converge, not
  // be re-attempted forever.
  it("GUARD: a legitimate zero-aspect suggestion still stamps aspects_backfilled_at, so it is never retried", async () => {
    mockSuggestAi(() => JSON.stringify({ subject: "a plain object", title: "A plain thing", category: "other", condition: "", aspects: [] }));
    const ownerId = await insertOwner();
    const listingId = await insertListingWithCoverPhoto({ ownerId });

    const first = await runAspectsBackfillBatch(env, 5);
    expect(first.processed).toBe(1);
    expect(first.withoutAspects).toBe(1);
    expect(first.remaining).toBe(0);
    expect(await fetchAspects(listingId)).toEqual([]);
    expect(await fetchBackfilledAt(listingId)).not.toBeNull();

    // Confirmed by breaking it: moving the `markAttempted` call so it only
    // runs on the `with_aspects` branch (instead of unconditionally, once
    // per row regardless of outcome) makes the *first* run's own
    // `expect(first.remaining).toBe(0)` above fail — with no stamp, the
    // zero-aspect listing still matches `aspects_backfilled_at IS NULL`,
    // so it counts as still-remaining even though it was just attempted.
    // That's the exact infinite-reprocessing bug this column exists to
    // prevent; the second run below is the same guarantee from the other
    // side (a second call must not re-suggest a listing already attempted).
    mockSuggestAi(() => {
      throw new Error("must not be called again — this listing was already attempted");
    });
    const second = await runAspectsBackfillBatch(env, 5);
    expect(second.processed).toBe(0);
    expect(second.remaining).toBe(0);
  });

  it("skips a listing that already has real aspects, without spending budget on it", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertListingWithCoverPhoto({ ownerId });
    await env.DB.prepare("INSERT INTO listing_aspects (id, listing_id, name, value, position, created_at) VALUES (?, ?, 'material', 'ceramic', 0, ?)")
      .bind(ulid(), listingId, Date.now())
      .run();

    mockSuggestAi(() => {
      throw new Error("must not be called — this listing already has aspects");
    });
    const result = await runAspectsBackfillBatch(env, 5);
    expect(result.processed).toBe(0);
    expect(result.remaining).toBe(0);
    // Never stamped either — it was never a candidate in the first place,
    // not "attempted and skipped".
    expect(await fetchBackfilledAt(listingId)).toBeNull();
  });

  it("stops and reports budget_exhausted once the shared suggest budget runs out, leaving later candidates untouched", async () => {
    setTestEnvVar("SUGGEST_DAILY_BUDGET", "1");
    mockSuggestAi(() => TEAPOT_SUGGESTION_JSON);
    const ownerId = await insertOwner();
    const first = await insertListingWithCoverPhoto({ ownerId });
    const second = await insertListingWithCoverPhoto({ ownerId });

    const result = await runAspectsBackfillBatch(env, 5);
    expect(result.processed).toBe(1);
    expect(result.budgetExhausted).toBe(true);
    expect(result.remaining).toBe(1);

    const firstDone = (await fetchBackfilledAt(first)) !== null;
    const secondDone = (await fetchBackfilledAt(second)) !== null;
    // Exactly one of the two was processed before the shared budget ran out.
    expect([firstDone, secondDone].filter(Boolean)).toHaveLength(1);

    setTestEnvVar("SUGGEST_DAILY_BUDGET", "1000");
  });

  it("respects the batch limit, leaving the rest for a later call (resumability)", async () => {
    mockSuggestAi(() => TEAPOT_SUGGESTION_JSON);
    const ownerId = await insertOwner();
    await insertListingWithCoverPhoto({ ownerId });
    await insertListingWithCoverPhoto({ ownerId });
    await insertListingWithCoverPhoto({ ownerId });

    const firstBatch = await runAspectsBackfillBatch(env, 2);
    expect(firstBatch.processed).toBe(2);
    expect(firstBatch.remaining).toBe(1);

    const secondBatch = await runAspectsBackfillBatch(env, 2);
    expect(secondBatch.processed).toBe(1);
    expect(secondBatch.remaining).toBe(0);
  });

  it("continues past a single row that throws unexpectedly, and still stamps it so it isn't retried forever", async () => {
    let callIndex = 0;
    env.AI.run = (async () => {
      callIndex += 1;
      if (callIndex === 1) throw new Error("simulated unexpected failure");
      return TEAPOT_SUGGESTION_JSON;
    }) as unknown as Ai["run"];

    const ownerId = await insertOwner();
    const failing = await insertListingWithCoverPhoto({ ownerId });
    const succeeding = await insertListingWithCoverPhoto({ ownerId });

    const result = await runAspectsBackfillBatch(env, 5);
    // suggestFromPhoto itself catches AI.run throwing and returns
    // `{ suggestion: null }` rather than propagating — so this exercises
    // the "no aspects" path, not the try/catch around it, and that's fine:
    // both listings should still end up processed and stamped.
    expect(result.processed).toBe(2);
    expect(await fetchBackfilledAt(failing)).not.toBeNull();
    expect(await fetchBackfilledAt(succeeding)).not.toBeNull();
  });
});

describe("POST /api/admin/backfill-aspects", () => {
  beforeEach(() => setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN));

  it("401s without a valid admin token", async () => {
    const res = await SELF.fetch("http://x/api/admin/backfill-aspects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("runs a batch and reports the shape the admin needs to decide whether to call again", async () => {
    mockSuggestAi(() => TEAPOT_SUGGESTION_JSON);
    const ownerId = await insertOwner();
    await insertListingWithCoverPhoto({ ownerId });

    const res = await SELF.fetch("http://x/api/admin/backfill-aspects", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ limit: 5 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      data: { processed: number; with_aspects: number; without_aspects: number; failed: number; budget_exhausted: boolean; remaining: number };
    };
    expect(body.data.processed).toBe(1);
    expect(body.data.with_aspects).toBe(1);
    expect(body.data.remaining).toBe(0);
  });

  it("defaults limit to 5 when the body is an empty object", async () => {
    mockSuggestAi(() => TEAPOT_SUGGESTION_JSON);
    const ownerId = await insertOwner();
    for (let i = 0; i < 6; i++) {
      await insertListingWithCoverPhoto({ ownerId });
    }

    const res = await SELF.fetch("http://x/api/admin/backfill-aspects", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { processed: number; remaining: number } };
    expect(body.data.processed).toBe(5);
    expect(body.data.remaining).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Issue #38 × #37. `reembedListing`'s doc comment always said this job should
// call it; #37 landed first, nothing did, and an aspect the backfill wrote
// stayed invisible to vector search until a human edited that listing. This
// job is also the only path that reaches listings created before semantic
// search existed — which, the day the flag went on, was every listing in
// production (#135 measured one).
//
// `vitest.config.ts` pins SEMANTIC_SEARCH to "0" for the whole suite, so the
// blocks above exercise the flag-off shape by default and these opt in
// explicitly, the same way `search.test.ts` does.
// ---------------------------------------------------------------------------
describe("runAspectsBackfillBatch re-embeds each listing it touches (#38)", () => {
  it("writes a vector for a listing it gave aspects to", async () => {
    setTestEnvVar("SEMANTIC_SEARCH", "1");
    const vectorize = installFakeVectorize();
    mockSuggestAi(() => TEAPOT_SUGGESTION_JSON);
    const ownerId = await insertOwner();
    const listingId = await insertListingWithCoverPhoto({ ownerId });

    const result = await runAspectsBackfillBatch(env, 5);

    expect(result.withAspects).toBe(1);
    expect(await fetchAspects(listingId)).not.toHaveLength(0);
    // The point of the whole wiring: the aspects the job just wrote are
    // searchable now, not after somebody edits the listing by hand.
    expect(vectorize.has(listingId)).toBe(true);
    expect(embeddingCallCount).toBe(1);
  });

  it("writes a vector even when the model names no aspect at all (#40)", async () => {
    setTestEnvVar("SEMANTIC_SEARCH", "1");
    const vectorize = installFakeVectorize();
    mockSuggestAi(() => JSON.stringify({ subject: "a teapot", title: "Copper teapot", category: "home_kitchen", condition: "", aspects: [] }));
    const ownerId = await insertOwner();
    const listingId = await insertListingWithCoverPhoto({ ownerId });

    const result = await runAspectsBackfillBatch(env, 5);

    // Zero aspects is the case #40 is about, and the case that most needs a
    // route in other than an aspect filter. The vector is built from title +
    // story too, so it exists regardless.
    expect(result.withoutAspects).toBe(1);
    expect(await fetchAspects(listingId)).toHaveLength(0);
    expect(vectorize.has(listingId)).toBe(true);
  });

  it("spends no embedding call and writes no vector with SEMANTIC_SEARCH off", async () => {
    setTestEnvVar("SEMANTIC_SEARCH", "0");
    const vectorize = installFakeVectorize();
    mockSuggestAi(() => TEAPOT_SUGGESTION_JSON);
    const ownerId = await insertOwner();
    const listingId = await insertListingWithCoverPhoto({ ownerId });

    const result = await runAspectsBackfillBatch(env, 5);

    // The kill switch has to hold on this path too, or turning the feature
    // off would still leave the backfill spending AI budget on it.
    expect(result.withAspects).toBe(1);
    expect(embeddingCallCount).toBe(0);
    expect(vectorize.has(listingId)).toBe(false);

    // ...and prove that "no vector" is the flag's doing rather than the
    // wiring simply being absent. Without this half, deleting the
    // `reembedListing` call from the job entirely would leave this test
    // green — the exact shape of unfailable guard the rest of this PR was
    // written to avoid. Same listing, same fixture, flag on:
    setTestEnvVar("SEMANTIC_SEARCH", "1");
    await env.DB.prepare("UPDATE listings SET aspects_backfilled_at = NULL WHERE id = ?").bind(listingId).run();
    await env.DB.prepare("DELETE FROM listing_aspects WHERE listing_id = ?").bind(listingId).run();
    await env.KV.delete(`budget:suggest:${todayISO()}`);

    await runAspectsBackfillBatch(env, 5);

    expect(embeddingCallCount).toBe(1);
    expect(vectorize.has(listingId)).toBe(true);
  });
});

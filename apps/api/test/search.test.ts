/**
 * Semantic search (issue #38): the query-side threshold guard
 * (`src/search/search.ts`), the three fallback triggers `routes/feed.ts`
 * documents (Vectorize unavailable, the embedding call failing, and
 * Vectorize answering with nothing above `MIN_SCORE`), the #40 zero-aspect
 * guarantee applied to search rather than the feed, and the create/edit/
 * delete write paths that keep a listing's vector in step with its content
 * (`src/search/reembed.ts`, `src/routes/listings.ts`).
 *
 * `env.AI.run` is stubbed per-test rather than actually calling Workers AI —
 * same convention `test/moderation.test.ts` already uses — with a fixture
 * table keyed by the *exact* embedding input text, not a real text encoder.
 * That proves the code path calls `env.AI`/`env.VECTORIZE` with the right
 * inputs and reacts correctly to their outputs. It proves nothing about the
 * model. A fixture that says "these two texts are similar" is the test
 * author asserting the answer, not the model producing it — so none of these
 * blocks may be cited as evidence that `MODELS.embedding` actually places
 * related listings near each other in real vector space.
 *
 * The one block that *would* be such evidence is "real Workers AI
 * embeddings" at the bottom, gated behind `REAL_AI=1`. It is skipped by
 * default, and it has now been run once with a real credential (recorded in
 * `docs/runbooks/deploy.md` → "Vectorize / semantic search"). Skipped is
 * still its normal state: CI sets no `CLOUDFLARE_API_TOKEN`, so the three
 * skips in a green run are expected, not a warning sign. See its own
 * comment.
 *
 * An earlier revision of this header claimed the real-service run was "done
 * separately (see the issue's closing comment)". There was no such comment
 * on issue #38 at the time and no artifact of that run existed anywhere, so
 * the claim was removed rather than left pointing at nothing. The run that
 * did eventually happen is cited above by its runbook section, which is what
 * that claim should have pointed at.
 */
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { FeedPage } from "@keepsake/contracts/feed";
import type { OwnerListing, PublicListing } from "@keepsake/contracts/listing";
import type { PublicPhoto } from "@keepsake/contracts/photo";
import { MODELS } from "../src/models.js";
import { embed, embeddingText } from "../src/search/embedding.js";
import { reembedListing } from "../src/search/reembed.js";
import { vectorSearchCandidates } from "../src/search/search.js";
import {
  authHeaders,
  freshOwnerToken,
  installFakeVectorize,
  insertApprovedListing,
  insertOwner,
  readOk,
  removeFakeVectorize,
  seedStandardPostalCodes,
  setTestEnvVar,
  uploadPhoto,
  waitFor,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// Fake embeddings: a fixture table keyed by the exact text `embeddingText()`
// would build, not a real encoder. `mockEmbeddings` also answers
// textGuard/imageVision so the full create/edit/delete route flow (which
// always kicks off `moderateListing` too) works with MOCK_AI flipped off.
// ---------------------------------------------------------------------------

const SAFE_TEXT_RESPONSE = "safe";
const PASS_IMAGE_JSON = JSON.stringify({
  is_physical_object: true,
  nsfw: 0,
  violence: 0,
  weapons: 0,
  drugs: 0,
  hate_symbols: 0,
  personal_info: 0,
  notes: "",
});

let embeddingFixtures: Record<string, number[]>;
// Counts every call that reaches the embedding branch, independent of
// whether it succeeds — a test asserting "no re-embed happened" checks this
// counter, not just the resulting vector. Checking only the resulting
// vector is a real trap here: a category-only edit recomputes the exact
// same `embeddingText()` string as before, so a bug that re-embeds on every
// edit would still land the *same* vector and a final-state-only assertion
// could never catch it (confirmed while writing this file — see the
// issue's closing comment for the deliberate break-and-watch-it-fail on
// this exact guard).
let embeddingCallCount = 0;

function mockAi(): void {
  embeddingFixtures = {};
  embeddingCallCount = 0;
  const run = async (model: string, input?: unknown) => {
    if (model === MODELS.textGuard) return SAFE_TEXT_RESPONSE;
    if (model === MODELS.imageVision) return PASS_IMAGE_JSON;
    if (model === MODELS.embedding) {
      embeddingCallCount += 1;
      const text = (input as { text: string }).text;
      const vector = embeddingFixtures[text];
      if (!vector) throw new Error(`mockAi: no embedding fixture for text ${JSON.stringify(text)}`);
      return { shape: [1, vector.length], data: [vector] };
    }
    throw new Error(`mockAi: unexpected model ${model}`);
  };
  env.AI.run = run as unknown as Ai["run"];
}

function fixtureEmbedding(text: string, vector: number[]): void {
  embeddingFixtures[text] = vector;
}

beforeEach(async () => {
  setTestEnvVar("MOCK_AI", "0");
  // `vitest.config.ts` pins the test default to "0" even though every
  // deployed environment now has SEMANTIC_SEARCH on (see
  // `semanticSearchEnabled` in src/env.ts). That asymmetry is deliberate and
  // worth keeping: the blocks below that exercise the vector path opt in
  // explicitly, so nothing reaches Vectorize by accident from a test that
  // never mentioned it, and the flag-off equivalence with FTS stays the
  // default shape under test rather than a special case. The "flag off"
  // block resets it to "0" itself.
  setTestEnvVar("SEMANTIC_SEARCH", "1");
  mockAi();
  installFakeVectorize();
  await seedStandardPostalCodes();
});

async function fetchFeed(query: string): Promise<Response> {
  return SELF.fetch(`http://x/api/feed${query}`);
}

// ---------------------------------------------------------------------------
// The MIN_SCORE guard itself — unit-level, no HTTP, no D1 join. Directly
// exercises the branch that makes "Vectorize answered but nothing cleared
// the bar" a real, distinguishable outcome from "Vectorize is unavailable".
// ---------------------------------------------------------------------------
describe("vectorSearchCandidates: relevance threshold", () => {
  it("filters out a match whose cosine score is too low to call relevant", async () => {
    const fake = installFakeVectorize();
    await fake.upsert([{ id: "low-relevance", values: [1, 0] }]);
    fixtureEmbedding("orthogonal query", [0, 1]); // cosine similarity 0

    const result = await vectorSearchCandidates(env, "orthogonal query");
    // Vectorize was reachable and answered — this is the "nothing useful"
    // case, distinct from `null` ("couldn't try at all").
    expect(result).toEqual([]);
  });

  it("keeps a match whose cosine score clears the bar", async () => {
    const fake = installFakeVectorize();
    await fake.upsert([{ id: "high-relevance", values: [1, 0] }]);
    fixtureEmbedding("matching query", [1, 0]); // cosine similarity 1

    const result = await vectorSearchCandidates(env, "matching query");
    expect(result).toEqual([{ id: "high-relevance", score: 1 }]);
  });

  // The two tests above use cosine 0 and cosine 1 — the extreme ends. They
  // pass for ANY threshold in (0, 1], which is precisely how MIN_SCORE sat at
  // 0.3 for so long without anyone noticing it was unreachable: no score this
  // model produces for anything ever falls below ~0.40, so the "nothing
  // cleared the bar" fallback could never fire. A guard that cannot fail.
  //
  // These two pin MIN_SCORE to the band the real-model calibration actually
  // justifies (docs/design/min-score-calibration.md, re-runnable via
  // tools/calibrate-min-score.mjs):
  //
  //   off-corpus queries scored up to 0.6151, best-case 0.4850
  //   true matches scored down to 0.5693
  //
  // Those overlap, so no cutoff separates them and MIN_SCORE is a floor, not
  // a relevance classifier. 0.5 is below every true match observed and above
  // the clearly-unrelated end. Move it out of that band — up toward 0.62 to
  // "improve precision", or back down below 0.485 — and one of these fails.
  it("rejects a score from the measured off-corpus band (MIN_SCORE is above the noise floor)", async () => {
    const fake = installFakeVectorize();
    await fake.upsert([{ id: "noise-floor", values: [1, 0] }]);
    // cos(60.99°) ≈ 0.4850 — the best score a Kubernetes question scored
    // against this corpus, i.e. a query with no answer in the index at all.
    fixtureEmbedding("nothing like this in the index", [0.485, Math.sqrt(1 - 0.485 ** 2)]);

    const result = await vectorSearchCandidates(env, "nothing like this in the index");
    expect(result, "a score at the measured off-corpus floor must not clear MIN_SCORE").toEqual([]);
  });

  it("keeps a score from the measured true-match band (MIN_SCORE does not drop real matches)", async () => {
    const fake = installFakeVectorize();
    await fake.upsert([{ id: "weakest-true-match", values: [1, 0] }]);
    // 0.5693 — the weakest genuine match in the calibration run ("something
    // for feeding a toddler at the table" → a terse "Wooden high chair").
    fixtureEmbedding("terse listing, oblique query", [0.5693, Math.sqrt(1 - 0.5693 ** 2)]);

    const result = await vectorSearchCandidates(env, "terse listing, oblique query");
    expect(result?.map((m) => m.id), "the weakest real match measured must survive MIN_SCORE").toEqual([
      "weakest-true-match",
    ]);
  });

  it("returns null (not empty) when embedding the query fails, distinct from a real empty answer", async () => {
    // No fixture installed for this text — mockAi's run() throws, which
    // embed() catches and turns into null.
    const result = await vectorSearchCandidates(env, "text with no fixture");
    expect(result).toBeNull();
  });

  it("returns null when the query string is blank", async () => {
    expect(await vectorSearchCandidates(env, "   ")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The #40 zero-aspect guarantee, applied to search: a listing the model (or,
// here, the fixture standing in for it) said nothing useful about in
// aspects, and whose story shares zero literal words with the query, must
// still be findable — proving the *vector* path found it, not FTS, since
// FTS has nothing lexical to match against.
// ---------------------------------------------------------------------------
describe("GET /api/feed?q= — vector search finds a zero-aspect listing FTS never could", () => {
  it("surfaces a listing via semantic similarity alone, with no aspects and no lexical overlap", async () => {
    const ownerId = await insertOwner();
    const title = "A well-loved keepsake";
    const story = "This belonged to a dear friend of the family, kept safe in a drawer for decades.";
    const listingId = await insertApprovedListing({ ownerId, title, story });
    // No listing_aspects rows inserted at all — the #40 case.

    const query = "antique navigational instrument";
    // "antique"/"navigational"/"instrument" appear nowhere in title or
    // story — confirmed directly, not just asserted in a comment.
    for (const word of ["antique", "navigational", "instrument"]) {
      expect(`${title} ${story}`.toLowerCase()).not.toContain(word);
    }

    // With Vectorize unavailable, FTS is genuinely all that's left — and it
    // finds nothing, proving this query has zero lexical route to the
    // listing. This is the control: without it, a later false positive
    // couldn't be told apart from FTS having matched by coincidence.
    removeFakeVectorize();
    const ftsOnlyPage = await readOk<FeedPage<PublicListing>>(await fetchFeed("?q=" + encodeURIComponent(query)));
    expect(ftsOnlyPage.items.map((item) => item.id)).not.toContain(listingId);
    installFakeVectorize();

    const text = embeddingText(title, story, []);
    fixtureEmbedding(text, [1, 0, 0]);
    fixtureEmbedding(query, [0.99, 0.02, 0]); // same direction, no shared words
    await reembedListing(env, listingId);

    const page = await readOk<FeedPage<PublicListing>>(await fetchFeed("?q=" + encodeURIComponent(query)));
    expect(page.items.map((item) => item.id)).toContain(listingId);
  });
});

// ---------------------------------------------------------------------------
// The three fallback triggers, each isolated so a test can name exactly
// which one it drives (docs/runbooks and the issue both ask for this).
// ---------------------------------------------------------------------------
describe("GET /api/feed?q= — fallback to FTS", () => {
  it("falls back when env.VECTORIZE is unavailable (binding missing)", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({
      ownerId,
      title: "A lighthouse lens",
      story: "An old lighthouse lens my grandfather kept on his desk for years.",
    });

    removeFakeVectorize();
    try {
      const page = await readOk<FeedPage<PublicListing>>(await fetchFeed("?q=lighthouse"));
      expect(page.items.map((item) => item.id)).toContain(listingId);
    } finally {
      installFakeVectorize();
    }
  });

  it("falls back when the embedding call throws", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({
      ownerId,
      title: "A lighthouse lens",
      story: "An old lighthouse lens my grandfather kept on his desk for years.",
    });

    // mockAi()'s run() throws for any model/text with no fixture — never
    // registering one for this listing's embeddingText (or the query)
    // means both the write-time embed and the read-time embed fail closed.
    const page = await readOk<FeedPage<PublicListing>>(await fetchFeed("?q=lighthouse"));
    expect(page.items.map((item) => item.id)).toContain(listingId);
  });

  it("falls back when Vectorize answers but nothing clears the relevance bar", async () => {
    const ownerId = await insertOwner();
    const title = "A lighthouse lens";
    const story = "An old lighthouse lens my grandfather kept on his desk for years.";
    const listingId = await insertApprovedListing({ ownerId, title, story });

    fixtureEmbedding(embeddingText(title, story, []), [1, 0]);
    fixtureEmbedding("lighthouse", [0, 1]); // orthogonal -> cosine 0, below MIN_SCORE
    await reembedListing(env, listingId);

    const page = await readOk<FeedPage<PublicListing>>(await fetchFeed("?q=lighthouse"));
    expect(page.items.map((item) => item.id)).toContain(listingId);
  });
});

// ---------------------------------------------------------------------------
// Issue #180: a listing whose embedding call failed.
//
// Two defects, both exercised here:
//
//  1. `routes/feed.ts` chose the vector path or the FTS path for the *whole*
//     query (`useVector = vectorMatches.length > 0`), so a listing with no
//     vector could not be returned by any query that some *other* listing
//     answered semantically — including its own exact-title search.
//     `reembed.ts`'s comment claimed such a listing was "still findable by
//     title/story through FTS in the meantime"; that only held for queries
//     returning zero vector matches.
//  2. Nothing recorded that the vector was missing. Every failure path in
//     `reembedListing` returned void — no event, no counter, no column —
//     so "this listing was never indexed" was not a fact anything could
//     query, and no retry had anything to select on.
//
// The load-bearing case for (1) is the one the old code got wrong: another
// listing clears MIN_SCORE. A test where nothing clears it passes on the
// broken code too, because then FTS was the whole answer anyway.
// ---------------------------------------------------------------------------
describe("a listing with no vector is still findable (issue #180)", () => {
  async function seedIndexedAndUnindexed(): Promise<{ indexed: string; unindexed: string; query: string }> {
    const ownerId = await insertOwner();

    // A: embeds fine, and scores above MIN_SCORE for the query below.
    const indexedTitle = "A copper teapot";
    const indexedStory = "It sat on my aunt's stove for thirty years and still pours straight.";
    const indexed = await insertApprovedListing({ ownerId, title: indexedTitle, story: indexedStory });
    fixtureEmbedding(embeddingText(indexedTitle, indexedStory, []), [1, 0]);
    await reembedListing(env, indexed);

    // B: the exact-title match, whose embedding call fails — no fixture is
    // registered for its text, so `mockAi`'s run() throws and `embed`
    // returns null, exactly like a Workers AI hiccup during the create.
    const unindexedTitle = "Brass reading lamp";
    const unindexedStory = "The lamp from the corner of my father's study, rewired last spring.";
    const unindexed = await insertApprovedListing({ ownerId, title: unindexedTitle, story: unindexedStory });
    await reembedListing(env, unindexed);

    // cos(query, A) = 1/sqrt(1.81) ≈ 0.743 — comfortably above MIN_SCORE,
    // so the vector path leads and, before this fix, FTS never ran.
    const query = "brass reading lamp";
    fixtureEmbedding(query, [1, 0.9]);
    return { indexed, unindexed, query };
  }

  it("is returned when ANOTHER listing clears MIN_SCORE — the case the old path selection got wrong", async () => {
    const { indexed, unindexed, query } = await seedIndexedAndUnindexed();

    // The premise, asserted rather than assumed: the vector path really is
    // in charge for this query.
    const matches = await vectorSearchCandidates(env, query);
    expect(matches?.map((match) => match.id), "the indexed listing must clear MIN_SCORE").toContain(indexed);
    expect(matches?.map((match) => match.id), "the un-indexed listing has no vector to match").not.toContain(unindexed);

    const page = await readOk<FeedPage<PublicListing>>(await fetchFeed("?q=" + encodeURIComponent(query)));
    const ids = page.items.map((item) => item.id);
    expect(ids, "the un-embedded listing must not vanish from its own exact-title search").toContain(unindexed);
    expect(ids, "the vector match is still there — this is a merge, not a swap").toContain(indexed);
    // Vector rank leads; FTS-only rows are appended behind it.
    expect(ids.indexOf(indexed)).toBeLessThan(ids.indexOf(unindexed));
  });

  it("is returned on the geo+search path too, where the same choice was made", async () => {
    const { indexed, unindexed, query } = await seedIndexedAndUnindexed();

    const page = await readOk<FeedPage<PublicListing>>(
      await fetchFeed(`?q=${encodeURIComponent(query)}&country=US&postal=02144`),
    );
    const ids = page.items.map((item) => item.id);
    expect(ids).toContain(unindexed);
    expect(ids).toContain(indexed);
  });

  it("records the missing vector: vector_indexed_at is NULL for it and set for the indexed one", async () => {
    const { indexed, unindexed } = await seedIndexedAndUnindexed();

    const row = async (id: string) =>
      env.DB.prepare("SELECT vector_indexed_at FROM listings WHERE id = ?").bind(id).first<{ vector_indexed_at: number | null }>();

    expect((await row(indexed))?.vector_indexed_at, "a successful upsert must be recorded").toEqual(expect.any(Number));
    expect((await row(unindexed))?.vector_indexed_at, "a failed embed must leave the listing marked un-indexed").toBeNull();

    // The whole point of the column: "which listings are missing from the
    // semantic index" is a query, not a guess.
    const missing = await env.DB.prepare(
      "SELECT id FROM listings WHERE vector_indexed_at IS NULL AND id IN (?, ?)",
    )
      .bind(indexed, unindexed)
      .all<{ id: string }>();
    expect(missing.results.map((r) => r.id)).toEqual([unindexed]);
  });

  it("clears vector_indexed_at when a later re-embed fails, so a stale vector is not mistaken for a current one", async () => {
    const ownerId = await insertOwner();
    const title = "A walnut stool";
    const story = "Three legs, one wobble, and forty years of being sat on.";
    const listingId = await insertApprovedListing({ ownerId, title, story });

    fixtureEmbedding(embeddingText(title, story, []), [1, 0]);
    await reembedListing(env, listingId);
    const afterSuccess = await env.DB.prepare("SELECT vector_indexed_at FROM listings WHERE id = ?")
      .bind(listingId)
      .first<{ vector_indexed_at: number | null }>();
    expect(afterSuccess?.vector_indexed_at).toEqual(expect.any(Number));

    // The story changes and the re-embed fails: whatever is in the index now
    // describes text this listing no longer has.
    const newStory = "Repainted last month, and now it lives by the back door.";
    await env.DB.prepare("UPDATE listings SET story = ? WHERE id = ?").bind(newStory, listingId).run();
    await reembedListing(env, listingId); // no fixture for the new text -> embed returns null

    const afterFailure = await env.DB.prepare("SELECT vector_indexed_at FROM listings WHERE id = ?")
      .bind(listingId)
      .first<{ vector_indexed_at: number | null }>();
    expect(afterFailure?.vector_indexed_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Re-embed on write: create, edit, and delete.
// ---------------------------------------------------------------------------

const VALID_LISTING_BODY = {
  title: "A quiet teacup",
  story: "This was my grandmother's favorite teacup, and I'd love for it to find a new home.",
  category: "home_kitchen",
  country: "US",
  postal_code: "02144",
  // `date_of_birth`, not the old `age_attested: true` — #93 dropped the age
  // checkbox for a DOB prompt, and this file was written before that landed.
  // Kept identical to `test/listings.test.ts`'s body so the two don't drift.
  date_of_birth: "1990-01-01",
  // Required since the give flow stopped offering a "Skip" on its email
  // step: `POST /api/listings` refuses a first listing with no way back to
  // its giver (neither the body nor the owner row carrying an address).
  email: "giver@keepsake.ing",
};

async function createListingWithPhoto(token: string, overrides: Record<string, unknown> = {}): Promise<OwnerListing> {
  const photo = await readOk<PublicPhoto>(await uploadPhoto({ token }));
  fixtureEmbedding(
    embeddingText(
      (overrides.title as string) ?? VALID_LISTING_BODY.title,
      (overrides.story as string) ?? VALID_LISTING_BODY.story,
      (overrides.aspects as { name: string; value: string }[]) ?? [],
    ),
    [1, 0],
  );
  const res = await SELF.fetch("http://x/api/listings", {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ ...VALID_LISTING_BODY, photo_ids: [photo.id], ...overrides }),
  });
  return readOk<OwnerListing>(res);
}

describe("write paths re-embed (issue #38)", () => {
  it("POST /api/listings embeds the new listing", async () => {
    const token = freshOwnerToken();
    const listing = await createListingWithPhoto(token);

    const fake = env.VECTORIZE as unknown as import("./helpers.js").FakeVectorizeIndex;
    await waitFor(async () => (fake.has(listing.id) ? true : undefined));
    expect(fake.valuesFor(listing.id)).toEqual([1, 0]);
  });

  it("PATCH re-embeds when the story changes", async () => {
    const token = freshOwnerToken();
    const listing = await createListingWithPhoto(token);
    const fake = env.VECTORIZE as unknown as import("./helpers.js").FakeVectorizeIndex;
    await waitFor(async () => (fake.has(listing.id) ? true : undefined));

    const newStory = "Actually, this was my grandfather's — a brass compass he carried at sea.";
    fixtureEmbedding(embeddingText(listing.title, newStory, []), [0, 1]);

    const res = await SELF.fetch(`http://x/api/listings/${listing.id}`, {
      method: "PATCH",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ story: newStory }),
    });
    expect(res.status).toBe(200);

    await waitFor(async () => {
      const values = fake.valuesFor(listing.id);
      return values && values[0] === 0 ? true : undefined;
    });
    expect(fake.valuesFor(listing.id)).toEqual([0, 1]);
  });

  it("PATCH does NOT re-embed when only photo_ids/category change (story/title/aspects untouched)", async () => {
    const token = freshOwnerToken();
    const listing = await createListingWithPhoto(token);
    const fake = env.VECTORIZE as unknown as import("./helpers.js").FakeVectorizeIndex;
    await waitFor(async () => (fake.has(listing.id) ? true : undefined));
    const callsBeforePatch = embeddingCallCount;

    const res = await SELF.fetch(`http://x/api/listings/${listing.id}`, {
      method: "PATCH",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ category: "books_letters" }),
    });
    expect(res.status).toBe(200);

    // Give any (incorrect) background re-embed a moment to land before
    // asserting it didn't. Checking the call count rather than the
    // resulting vector matters here: a category-only edit recomputes the
    // exact same embedding text as before, so a bug that re-embeds on
    // every edit would still land the *same* vector — only the call count
    // actually distinguishes "ran again" from "never ran".
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(embeddingCallCount).toBe(callsBeforePatch);
  });

  it("DELETE removes the listing's vector", async () => {
    const token = freshOwnerToken();
    const listing = await createListingWithPhoto(token);
    const fake = env.VECTORIZE as unknown as import("./helpers.js").FakeVectorizeIndex;
    await waitFor(async () => (fake.has(listing.id) ? true : undefined));

    const res = await SELF.fetch(`http://x/api/listings/${listing.id}`, {
      method: "DELETE",
      headers: authHeaders(token),
    });
    expect(res.status).toBe(200);

    await waitFor(async () => (fake.has(listing.id) ? undefined : true));
    expect(fake.has(listing.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SEMANTIC_SEARCH off — the shipping posture this branch actually merges in.
//
// The flag is "0" in all three wrangler.toml env blocks and .env.example
// because the Vectorize indexes are not confirmed to exist. That makes these
// the only tests in this file describing what a deployed environment really
// does today; everything above describes a path no request currently reaches.
//
// What has to hold: search behaves exactly as it does on main (FTS5 via
// db/fts.ts), and the vector machinery is not merely unused but unreachable
// — no embedding call, no Vectorize call, on the read path or the write one.
// ---------------------------------------------------------------------------
describe("SEMANTIC_SEARCH off: search is exactly main's FTS behaviour", () => {
  beforeEach(() => {
    setTestEnvVar("SEMANTIC_SEARCH", "0");
  });

  it("vectorSearchCandidates returns null without calling env.AI or env.VECTORIZE at all", async () => {
    // A fully-populated, perfectly-matching index — so that if the flag were
    // not checked, this query would certainly return a match. The assertion
    // is that it returns null anyway, and that nothing was consulted to
    // decide that: a flag checked *after* the embed call would still return
    // null here and would still be wrong, because it would spend a Workers
    // AI call and, on a real deploy, reach for an index that may not exist.
    const fake = installFakeVectorize();
    await fake.upsert([{ id: "would-have-matched", values: [1, 0] }]);
    fixtureEmbedding("matching query", [1, 0]);
    const callsBefore = embeddingCallCount;

    expect(await vectorSearchCandidates(env, "matching query")).toBeNull();
    expect(embeddingCallCount).toBe(callsBefore);
  });

  it("reembedListing writes no vector and spends no AI call on the write path", async () => {
    const ownerId = await insertOwner();
    const title = "A brass compass";
    const story = "My grandfather carried this at sea for thirty years.";
    const listingId = await insertApprovedListing({ ownerId, title, story });

    const fake = installFakeVectorize();
    // A fixture *is* registered, so a re-embed would succeed rather than
    // throw — this must fail if the code runs, not merely if it errors.
    fixtureEmbedding(embeddingText(title, story, []), [1, 0]);
    const callsBefore = embeddingCallCount;

    await reembedListing(env, listingId);

    expect(embeddingCallCount).toBe(callsBefore);
    expect(fake.has(listingId)).toBe(false);
  });

  it("GET /api/feed?q= returns the same page it returns with Vectorize removed entirely", async () => {
    const ownerId = await insertOwner();
    const lighthouse = await insertApprovedListing({
      ownerId,
      title: "A lighthouse lens",
      story: "An old lighthouse lens my grandfather kept on his desk for years.",
    });
    // Shares no word with the query — so a feed that ignored `q` and
    // returned everything would be caught here rather than passing.
    const decoy = await insertApprovedListing({
      ownerId,
      title: "A teacup",
      story: "Nothing to do with the sea at all.",
    });

    // Flag off, but the binding present and the index holding a vector that
    // would rank differently if the vector path were live.
    const fake = installFakeVectorize();
    await fake.upsert([{ id: lighthouse, values: [1, 0] }]);
    fixtureEmbedding("lighthouse", [1, 0]);

    const flagOff = await readOk<FeedPage<PublicListing>>(await fetchFeed("?q=lighthouse"));

    // The reference: no Vectorize binding whatsoever, unambiguously the FTS
    // path. Comparing against this rather than a hardcoded expected list is
    // what makes it an equivalence assertion — it stays meaningful if FTS
    // ranking itself changes later.
    removeFakeVectorize();
    const ftsOnly = await readOk<FeedPage<PublicListing>>(await fetchFeed("?q=lighthouse"));

    expect(flagOff.items.map((item) => item.id)).toEqual(ftsOnly.items.map((item) => item.id));
    expect(flagOff.items.map((item) => item.id)).toContain(lighthouse);
    expect(flagOff.items.map((item) => item.id)).not.toContain(decoy);
  });

  // -------------------------------------------------------------------------
  // Issue #40's failure mode, on the path that is actually live: a listing
  // the vision model found nothing to tag must still be findable. This is the
  // eBay problem the milestone exists to avoid — a lovely story nobody can
  // reach because the machine had no labels for it.
  //
  // The block far above tests the same guarantee through the *vector* path,
  // with a fixture standing in for the model. This one needs no model at all:
  // with SEMANTIC_SEARCH off, a zero-aspect listing has to surface on words
  // from its own title and story, through FTS, exactly as on main.
  // -------------------------------------------------------------------------
  it("a listing with ZERO aspects still surfaces via the FTS fallback", async () => {
    const ownerId = await insertOwner();
    const title = "A lighthouse lens";
    const story = "An old lighthouse lens my grandfather kept on his desk for years.";
    const listingId = await insertApprovedListing({ ownerId, title, story });

    // A decoy sharing none of the query words. Without it this test would
    // pass against a feed that ignored `q` altogether and returned
    // everything — "the listing is in the results" is only meaningful
    // alongside "and something else isn't". Found by breaking the FTS
    // fallback and watching the first version of this test stay green.
    const decoy = await insertApprovedListing({
      ownerId,
      title: "A teacup",
      story: "Nothing to do with the sea at all.",
    });

    // The #40 condition, asserted rather than assumed: not one aspect row.
    const aspectCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM listing_aspects WHERE listing_id = ?")
      .bind(listingId)
      .first<{ n: number }>();
    expect(aspectCount?.n).toBe(0);

    // Findable on a title word, a story-only word, and one spanning both.
    for (const query of ["lighthouse", "grandfather", "lens"]) {
      const page = await readOk<FeedPage<PublicListing>>(await fetchFeed("?q=" + encodeURIComponent(query)));
      const ids = page.items.map((item) => item.id);
      expect(ids, `query ${JSON.stringify(query)} should find the zero-aspect listing`).toContain(listingId);
      expect(ids, `query ${JSON.stringify(query)} must actually search, not return everything`).not.toContain(decoy);
    }
  });
});

// ---------------------------------------------------------------------------
// Real Workers AI embeddings — the only block here that can say anything
// about the model itself.
//
// Skipped unless REAL_AI=1 (wired through vitest.config.ts from the host
// env). It is NOT skipped for convenience: `env.AI` has no local emulator and
// always proxies to the real Workers AI API, which needs a Cloudflare
// credential this repo's CI deliberately does not give the test job.
//
// **This block has never been observed to run.** Every session that has
// worked on issue #38 has been in a sandbox with no CLOUDFLARE_API_TOKEN, so
// "it passes" is not something anyone can currently claim. It is written so
// a human with credentials can answer the question in one command:
//
//     REAL_AI=1 pnpm --filter @keepsake/api test
//
// Why it can't be a mock, and why these specific assertions: the failure this
// project has already shipped once (docs/design/moderation.md) was a model
// returning confident, well-shaped, meaningless output while every mocked
// test stayed green. The equivalent failure here is an embedding call that
// returns a vector of the right length encoding nothing — constant, uniform,
// or unrelated to its input. A fixture table cannot detect that, because the
// fixture *is* the answer. Only real output can, and only via a relative
// assertion: that the model puts related text closer together than unrelated
// text. An absolute cosine threshold here would be exactly the uncalibrated
// number `search.ts` warns about.
// ---------------------------------------------------------------------------

/** Captured at import time, before `mockAi()` in `beforeEach` overwrites it. */
const realAiRun = env.AI.run.bind(env.AI);

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const realAiEnabled = env.REAL_AI === "1";

describe.skipIf(!realAiEnabled)("real Workers AI embeddings (REAL_AI=1)", () => {
  beforeEach(() => {
    // Undo the stub the outer beforeEach installed — this block wants the
    // genuine binding, and MOCK_AI is already "0" there.
    env.AI.run = realAiRun as unknown as Ai["run"];
    setTestEnvVar("SEMANTIC_SEARCH", "1");
  });

  it("returns a 768-dim vector, the width the index-create command specifies", async () => {
    const vector = await embed(env, "A brass sextant my grandfather used at sea.");
    expect(vector).not.toBeNull();
    // 768 is not incidental: it is the `--dimensions` in wrangler.toml's
    // create commands. A model returning some other width means the index
    // those commands build cannot store it, and every upsert would fail in
    // production rather than here.
    expect(vector!.length).toBe(768);
  });

  it("is not degenerate: different inputs produce different vectors", async () => {
    // The decorative-output failure mode. A model — or a broken response
    // parse — returning the same vector regardless of input would pass the
    // similarity test below by accident, since everything would be
    // equidistant from everything.
    const a = await embed(env, "A brass sextant my grandfather used at sea.");
    const b = await embed(env, "A cast iron skillet from my mother's kitchen.");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toEqual(b);
    expect(new Set(a!).size).toBeGreaterThan(1); // not a constant-valued vector
  });

  it("places a related query nearer a zero-aspect story than an unrelated one (#40, for real)", async () => {
    // Exactly the #40 shape: title + story, no aspects at all, and a query
    // sharing no literal words with either — so FTS could never find it and
    // only real semantic similarity can.
    const title = "A well-loved keepsake";
    const story = "This belonged to a dear friend of the family, kept safe in a drawer for decades.";
    const listingText = embeddingText(title, story, []);

    const related = "a treasured old family heirloom kept for many years";
    const unrelated = "diesel engine torque specifications and gearbox ratios";

    for (const word of ["treasured", "heirloom", "many", "years"]) {
      expect(`${title} ${story}`.toLowerCase()).not.toContain(word);
    }

    const [listingVec, relatedVec, unrelatedVec] = await Promise.all([
      embed(env, listingText),
      embed(env, related),
      embed(env, unrelated),
    ]);
    expect(listingVec).not.toBeNull();
    expect(relatedVec).not.toBeNull();
    expect(unrelatedVec).not.toBeNull();

    const relatedScore = cosine(listingVec!, relatedVec!);
    const unrelatedScore = cosine(listingVec!, unrelatedVec!);

    // Relative, not absolute: this asserts the model has an opinion in the
    // right direction, which is the premise semantic search rests on. It
    // deliberately does NOT assert either score clears MIN_SCORE — that
    // number is uncalibrated (see search.ts), and calibrating it is a
    // separate errand for whoever can actually run this.
    console.log(`real-embeddings #40 check: related=${relatedScore.toFixed(4)} unrelated=${unrelatedScore.toFixed(4)}`);
    expect(relatedScore).toBeGreaterThan(unrelatedScore);
  });
});

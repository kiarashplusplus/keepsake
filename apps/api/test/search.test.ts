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
 * This is deliberate: it proves the code path calls `env.AI`/`env.VECTORIZE`
 * with the right inputs and reacts correctly to their outputs, but it
 * cannot prove bge-base-en-v1.5 actually places related listings near each
 * other in real vector space — only a run against the real service can, and
 * that's done separately (see the issue's closing comment) rather than
 * faked here, per this project's rule that a mocked AI call can never catch
 * a prompt/model problem (docs/design/moderation.md).
 */
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { FeedPage } from "@keepsake/contracts/feed";
import type { OwnerListing, PublicListing } from "@keepsake/contracts/listing";
import type { PublicPhoto } from "@keepsake/contracts/photo";
import { MODELS } from "../src/models.js";
import { embeddingText } from "../src/search/embedding.js";
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
// Re-embed on write: create, edit, and delete.
// ---------------------------------------------------------------------------

const VALID_LISTING_BODY = {
  title: "A quiet teacup",
  story: "This was my grandmother's favorite teacup, and I'd love for it to find a new home.",
  category: "home_kitchen",
  country: "US",
  postal_code: "02144",
  age_attested: true,
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

/**
 * Issue #163: `sanitizeFtsQuery` (`src/db/fts.ts`) and the `MATCH` calls it
 * feeds in `src/routes/feed.ts`.
 *
 * Why this file exists at all: every search test in `feed.test.ts` and
 * `search.test.ts` used a single alphabetic token — `grandmother`,
 * `lighthouse` — so the suite only ever exercised the one input shape that
 * worked. `?q=grandmother's ring`, the median query for a site about
 * sentimental objects, answered **500** with the raw D1 driver message in
 * the body, because the sanitizer deliberately kept `'` and `'` is not a
 * bareword character in FTS5's query grammar.
 *
 * The route cases below run against the real FTS5 in miniflare's D1 (the
 * same `migrations/0003_fts.sql` schema production runs), not a mock — a
 * mocked `MATCH` could not have this bug.
 */
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { FeedPage } from "@keepsake/contracts/feed";
import type { PublicListing } from "@keepsake/contracts/listing";
import { sanitizeFtsQuery } from "../src/db/fts.js";
import { insertApprovedListing, insertOwner, readOk } from "./helpers.js";

// ---------------------------------------------------------------------------
// The sanitizer itself.
// ---------------------------------------------------------------------------
describe("sanitizeFtsQuery", () => {
  it("splits a possessive instead of gluing it, and never emits a bare apostrophe", () => {
    // The bug: `'` was in the kept-character class, so the apostrophe
    // reached the FTS5 grammar verbatim and the query failed to parse.
    expect(sanitizeFtsQuery("grandmother's ring")).toBe('"grandmother" "s" "ring"*');
    expect(sanitizeFtsQuery("grandmother's ring")).not.toContain("'");
  });

  it("splits the typographic apostrophe an iOS keyboard produces, too", () => {
    // U+2019, not U+0027. A fix that only removed `'` from the keep-set
    // would delete this one instead of splitting on it, gluing the token to
    // `grandmothers` — which matches nothing, since the index holds
    // `grandmother` and `s` as separate tokens.
    expect(sanitizeFtsQuery("grandmother’s ring")).toBe('"grandmother" "s" "ring"*');
  });

  it("quotes every token, so a bareword operator is a term and not an operator", () => {
    expect(sanitizeFtsQuery("lighthouse OR teapot")).toBe('"lighthouse" "OR" "teapot"*');
    expect(sanitizeFtsQuery("lighthouse NEAR window")).toBe('"lighthouse" "NEAR" "window"*');
    expect(sanitizeFtsQuery("gold NOT ring")).toBe('"gold" "NOT" "ring"*');
    expect(sanitizeFtsQuery("salt AND pepper")).toBe('"salt" "AND" "pepper"*');
  });

  it("keeps the documented shape: implicit AND, prefix wildcard on the last token only", () => {
    expect(sanitizeFtsQuery("brass reading lamp")).toBe('"brass" "reading" "lamp"*');
  });

  it("still splits punctuation-joined words rather than welding them together", () => {
    expect(sanitizeFtsQuery("cat-toy")).toBe('"cat" "toy"*');
    expect(sanitizeFtsQuery("(paren) ^caret col:on ~tilde")).toBe('"paren" "caret" "col" "on" "tilde"*');
  });

  it("returns null when nothing survives, so no MATCH is issued at all", () => {
    expect(sanitizeFtsQuery("'")).toBeNull();
    expect(sanitizeFtsQuery("   ")).toBeNull();
    expect(sanitizeFtsQuery("--*^")).toBeNull();
  });

  it("keeps non-Latin script, which FTS5's unicode61 tokenizer indexes as words", () => {
    expect(sanitizeFtsQuery("你好")).toBe('"你好"*');
  });
});

// ---------------------------------------------------------------------------
// The route, against real FTS5.
// ---------------------------------------------------------------------------
describe("GET /api/feed?q= — inputs that used to 500", () => {
  let ringId: string;
  let teapotId: string;
  let lensId: string;

  beforeEach(async () => {
    const ownerId = await insertOwner();
    ringId = await insertApprovedListing({
      ownerId,
      title: "A gold ring",
      // The apostrophe is in the *stored* text too: FTS5's unicode61
      // tokenizer splits it at index time, which is the whole reason
      // splitting the query on it (rather than deleting it) works.
      story: "It was her grandmother's ring, kept in a drawer for fifty years.",
    });
    teapotId = await insertApprovedListing({
      ownerId,
      title: "A brass teapot",
      story: "Bought at a market in Lisbon and used every morning since.",
    });
    lensId = await insertApprovedListing({
      ownerId,
      title: "A lighthouse lens",
      story: "Kept by the window where it catches the afternoon light.",
    });
  });

  async function feed(q: string): Promise<Response> {
    return SELF.fetch(`http://x/api/feed?q=${encodeURIComponent(q)}`);
  }

  it("`grandmother's ring` returns 200 and finds the listing (the issue's motivating query)", async () => {
    const res = await feed("grandmother's ring");
    expect(res.status).toBe(200);
    const page = await readOk<FeedPage<PublicListing>>(res);
    expect(page.items.map((item) => item.id)).toContain(ringId);
    // Not "everything": a query that matched nothing would also contain no
    // teapot, so the pair of assertions is what makes this meaningful.
    expect(page.items.map((item) => item.id)).not.toContain(teapotId);
  });

  it("`grandmother` still finds `grandmother's` — the behaviour the apostrophe was kept for", async () => {
    const page = await readOk<FeedPage<PublicListing>>(await feed("grandmother"));
    expect(page.items.map((item) => item.id)).toContain(ringId);
  });

  it("a lone apostrophe is a 200, not a 500 with a driver message in the body", async () => {
    const res = await feed("'");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("D1_ERROR");
    expect(body).not.toContain("fts5");
  });

  it("`O'Brien` and `don't` are 200s", async () => {
    for (const q of ["O'Brien mug", "don't", "mom's"]) {
      const res = await feed(q);
      expect(res.status, `q=${q} must not 500`).toBe(200);
    }
  });

  it("a bareword `AND` is a 200 — FTS5 rejects `AND*` outright as a syntax error", async () => {
    // Measured against real SQLite while writing this: the old sanitizer
    // turned `?q=AND` into the MATCH string `AND*`, which FTS5 answers with
    // `fts5: syntax error near "AND"`.
    const res = await feed("AND");
    expect(res.status).toBe(200);
  });

  it("`OR` is a search term, not FTS5's OR operator", async () => {
    // Under the old sanitizer this was `lighthouse OR teapot*` — a real
    // boolean OR, returning both listings. The module documents implicit
    // AND, so a crafted query changed which rows came back.
    const page = await readOk<FeedPage<PublicListing>>(await feed("lighthouse OR teapot"));
    const ids = page.items.map((item) => item.id);
    expect(ids, "the OR operator must not widen the result set").not.toContain(teapotId);

    // Control: the same two words without the operator behave normally.
    const control = await readOk<FeedPage<PublicListing>>(await feed("lighthouse"));
    expect(control.items.map((item) => item.id)).toContain(lensId);
  });

  it("`NEAR` is a search term, not FTS5's proximity operator", async () => {
    // Neither the title nor the story of the lens listing contains the word
    // "near", so with `NEAR` neutralised this query matches nothing — while
    // the same two words without it do match.
    const page = await readOk<FeedPage<PublicListing>>(await feed("lighthouse NEAR window"));
    expect(page.items.map((item) => item.id)).not.toContain(lensId);

    const control = await readOk<FeedPage<PublicListing>>(await feed("lighthouse window"));
    expect(control.items.map((item) => item.id)).toContain(lensId);
  });

  it("the same inputs are 200s on the geo+search path, which builds its own MATCH", async () => {
    for (const q of ["grandmother's ring", "'", "AND"]) {
      const res = await SELF.fetch(`http://x/api/feed?q=${encodeURIComponent(q)}&lat=42.3958&lng=-71.0967`);
      expect(res.status, `geo q=${q} must not 500`).toBe(200);
    }
  });
});

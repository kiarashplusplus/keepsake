/**
 * Issue #186: geo + semantic search bound up to 105 parameters into one D1
 * statement — 100 ids from `SEARCH_TOP_K`, plus a category, plus four
 * bounding-box bounds — over D1's documented 100-parameter ceiling. Latent
 * today only because the catalogue is smaller than `topK`; it would have
 * started failing at roughly the moment the site got enough listings to be
 * worth searching, and the trigger is growth rather than a deploy, so
 * nothing in the Actions tab would have correlated with it.
 *
 * **Why these assertions and not "seed 100 listings, expect a 200".** The
 * local harness (miniflare/better-sqlite3) has a far higher parameter limit
 * than real D1, so the obvious integration test passes locally *for the
 * wrong reason* — it would have passed on the broken code too, which is the
 * check-that-cannot-fail shape AGENTS.md's table keeps recording. The
 * property that actually matters is the length of the bind array handed to
 * `.bind(...)`, so that is what is asserted here, on the statements
 * `buildCandidateRowStatements` produces.
 *
 * The real-D1 limit itself is not measured here: this container cannot
 * reach D1. It is Cloudflare's documented number, and that is stated rather
 * than implied.
 */
import { describe, expect, it } from "vitest";
import { buildCandidateRowStatements, D1_MAX_BOUND_PARAMS } from "../src/search/candidateRows.js";

const COLUMNS = "id, title, story";
const BBOX = { minLat: 42.0, maxLat: 42.8, minLng: -71.5, maxLng: -70.5 };

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `listing_${index}`);
}

function placeholderCount(sql: string): number {
  return (sql.match(/\?/g) ?? []).length;
}

describe("buildCandidateRowStatements: D1's 100-parameter ceiling", () => {
  it("never binds more than 100 parameters, at the exact shape that used to bind 105", () => {
    // `SEARCH_TOP_K = 100` ids + category + four bbox bounds — the geo +
    // semantic search call in `buildVectorGeoFeed`.
    const statements = buildCandidateRowStatements(COLUMNS, ids(100), { category: "home_kitchen", bbox: BBOX });

    expect(statements.length).toBeGreaterThan(1); // it had to split at all
    for (const statement of statements) {
      expect(statement.params.length, `bind array of ${statement.sql}`).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
      // The placeholders and the bind array must agree, or the chunking is
      // "correct" only by not being executed.
      expect(placeholderCount(statement.sql)).toBe(statement.params.length);
    }
  });

  it("holds for a corpus far larger than SEARCH_TOP_K, with every filter on", () => {
    const statements = buildCandidateRowStatements(COLUMNS, ids(1000), { category: "home_kitchen", bbox: BBOX });
    for (const statement of statements) {
      expect(statement.params.length).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
      expect(placeholderCount(statement.sql)).toBe(statement.params.length);
    }
  });

  it("covers every id exactly once, so chunking cannot silently drop candidates", () => {
    const all = ids(257);
    const statements = buildCandidateRowStatements(COLUMNS, all, { category: "home_kitchen", bbox: BBOX });
    const bound = statements.flatMap((statement) => statement.params.filter((param) => typeof param === "string" && param.startsWith("listing_")));
    expect(bound).toEqual(all);
    expect(new Set(bound).size).toBe(all.length);
  });

  it("repeats the filter parameters on every chunk, so a later chunk is filtered too", () => {
    const statements = buildCandidateRowStatements(COLUMNS, ids(250), { category: "home_kitchen", bbox: BBOX });
    for (const statement of statements) {
      expect(statement.sql).toContain("category = ?");
      expect(statement.sql).toContain("lat BETWEEN ? AND ?");
      expect(statement.params.slice(-5)).toEqual(["home_kitchen", BBOX.minLat, BBOX.maxLat, BBOX.minLng, BBOX.maxLng]);
    }
  });

  it("gives the ids the whole ceiling when there are no filters", () => {
    const statements = buildCandidateRowStatements(COLUMNS, ids(100), {});
    expect(statements).toHaveLength(1);
    expect(statements[0]?.params).toHaveLength(100);
  });

  it("keeps `status = 'approved'` on every chunk — it is a literal, not a bound parameter", () => {
    const statements = buildCandidateRowStatements(COLUMNS, ids(150), { bbox: BBOX });
    expect(statements.length).toBeGreaterThan(1);
    for (const statement of statements) {
      expect(statement.sql).toContain("status = 'approved'");
    }
  });

  it("issues nothing at all for an empty id list", () => {
    expect(buildCandidateRowStatements(COLUMNS, [], { category: "home_kitchen" })).toEqual([]);
  });
});

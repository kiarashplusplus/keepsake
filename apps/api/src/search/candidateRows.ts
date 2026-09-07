/**
 * Fetching listing rows for a set of Vectorize match ids, in chunks small
 * enough that no single D1 statement ever exceeds its bound-parameter
 * ceiling (issue #186).
 *
 * ## Why this file exists rather than one `id IN (…)` in `routes/feed.ts`
 *
 * `vectorSearchCandidates` asks Vectorize for `SEARCH_TOP_K = 100` matches
 * and returns every one scoring at or above `MIN_SCORE`. The feed then
 * fetched them all in a single `SELECT … WHERE id IN (?,?,…)` and pushed the
 * category and bounding-box filters onto the *same* bind list — up to
 * 100 ids + 1 category + 4 bbox bounds = **105 bound parameters**.
 * Cloudflare D1 caps a query at 100, so combined location-and-search browse
 * — the way the product is meant to be used — would have started answering
 * 500 the moment the catalogue grew past roughly `topK` listings. The
 * trigger is catalogue growth, not a deploy, so nothing in the Actions tab
 * would have correlated with it.
 *
 * Chunking rather than merely lowering `SEARCH_TOP_K`: the filter parameter
 * count can grow again (another filter, a second bbox), and a `topK` chosen
 * to leave room for today's five filter params is a landmine for whoever
 * adds the sixth. Here the id budget is computed *from* the filter count, so
 * the invariant holds however many filters a caller adds.
 *
 * ## Why the test asserts on bind arrays and not on a 200
 *
 * The local harness (miniflare/better-sqlite3) has a far higher parameter
 * limit than real D1, so a test that seeds 100 listings and expects a 200
 * passes locally **for the wrong reason** — the exact shape of
 * check-that-cannot-fail this repo keeps recording. `buildCandidateRowStatements`
 * is therefore exported and unit-tested on the statements it produces:
 * every one binds at most `D1_MAX_BOUND_PARAMS`, and together they cover
 * every id exactly once.
 */
import type { Env } from "../env.js";
import type { FeedListingRow } from "../lib/serialize.js";

/** Cloudflare D1's documented ceiling on bound parameters per query.
 * Not measured here — this container cannot reach real D1 — but it is the
 * documented limit and the one the local harness does *not* enforce. */
export const D1_MAX_BOUND_PARAMS = 100;

export interface CandidateBoundingBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

export interface CandidateRowFilters {
  category?: string | undefined;
  bbox?: CandidateBoundingBox | undefined;
}

export interface CandidateRowStatement {
  sql: string;
  params: unknown[];
}

/**
 * Splits `ids` across as many `SELECT … WHERE id IN (…)` statements as it
 * takes to keep every statement's bind array at or under
 * `D1_MAX_BOUND_PARAMS`, with the filter parameters (category, bounding box)
 * repeated on each one.
 *
 * Filtered the same way every other feed mode filters (`status = 'approved'`,
 * optional `category`, optional geo bounding box) — Vectorize itself knows
 * nothing about status or location, only similarity, so this is where a
 * match against a `pending`/`hidden`/`given` listing (the index isn't pruned
 * by status — see `search/reembed.ts`, it embeds regardless of status, the
 * same way `listings_fts`'s insert trigger does) gets excluded.
 */
export function buildCandidateRowStatements(
  columns: string,
  ids: string[],
  filters: CandidateRowFilters = {},
): CandidateRowStatement[] {
  if (ids.length === 0) return [];

  const filterConditions: string[] = [];
  const filterParams: unknown[] = [];
  if (filters.category) {
    filterConditions.push("category = ?");
    filterParams.push(filters.category);
  }
  if (filters.bbox) {
    filterConditions.push("lat BETWEEN ? AND ?", "lng BETWEEN ? AND ?");
    filterParams.push(filters.bbox.minLat, filters.bbox.maxLat, filters.bbox.minLng, filters.bbox.maxLng);
  }

  // The id budget is what's left of the ceiling after the filters have taken
  // their share — never zero, so a pathological filter count degrades to one
  // id per statement instead of looping forever.
  const idsPerStatement = Math.max(1, D1_MAX_BOUND_PARAMS - filterParams.length);

  const statements: CandidateRowStatement[] = [];
  for (let start = 0; start < ids.length; start += idsPerStatement) {
    const chunk = ids.slice(start, start + idsPerStatement);
    const placeholders = chunk.map(() => "?").join(",");
    const conditions = ["status = 'approved'", `id IN (${placeholders})`, ...filterConditions];
    statements.push({
      sql: `SELECT ${columns} FROM listings WHERE ${conditions.join(" AND ")}`,
      params: [...chunk, ...filterParams],
    });
  }
  return statements;
}

/**
 * Runs the chunked statements and merges their rows into one map, so callers
 * can re-apply their own rank order (`matches` is already sorted by vector
 * score; `IN (...)` is not).
 */
export async function fetchCandidateRows(
  env: Env,
  columns: string,
  ids: string[],
  filters: CandidateRowFilters = {},
): Promise<Map<string, FeedListingRow>> {
  const statements = buildCandidateRowStatements(columns, ids, filters);
  if (statements.length === 0) return new Map();

  const pages = await Promise.all(
    statements.map((statement) =>
      env.DB.prepare(statement.sql)
        .bind(...statement.params)
        .all<FeedListingRow>(),
    ),
  );

  const byId = new Map<string, FeedListingRow>();
  for (const page of pages) {
    for (const row of page.results) byId.set(row.id, row);
  }
  return byId;
}

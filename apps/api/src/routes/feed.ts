/**
 * `GET /api/feed` — three modes off one endpoint, per the plan's route
 * table and docs/design/feed.md:
 *
 *  - default: newest-first keyset on `(published_at DESC, id DESC)`.
 *  - `q`: semantic search first (`src/search/search.ts`, Vectorize +
 *    Workers AI embeddings, issue #38), ranked by vector score, bounded
 *    offset, **with the FTS5 matches merged in behind it** (`src/db/fts.ts`,
 *    `bm25` order, deduplicated by id). FTS5 alone answers the query when
 *    Vectorize is unavailable, embedding the query fails, or the vector
 *    search comes back with nothing useful — see `vectorSearchCandidates`
 *    (`src/search/search.ts`) and the `useVector` check in the route
 *    handler below for exactly which of those fired.
 *
 *    The merge is issue #180: this used to be a per-query choice of one
 *    path or the other, so a listing whose embedding call failed (nothing
 *    retries it, and `reembedListing` is fire-and-forget) was missing from
 *    its own exact-title search whenever any *other* listing cleared
 *    `MIN_SCORE`. Now a missing vector costs a listing its ranking, not its
 *    presence in the result set.
 *  - `country`+`postal` or `lat`+`lng`: bounding-box + haversine radius
 *    search, sorted by distance (or by search relevance when combined with
 *    `q` — see `buildGeoFeed`/`buildVectorGeoFeed` below), bounded offset.
 *
 * `category` applies as a filter in every mode. Only `status = 'approved'`
 * is ever selected — `given` listings are excluded from the feed (still
 * individually readable via `GET /api/listings/:id`) and nothing else
 * public is visible at all.
 */
import { Hono } from "hono";
import { captureException } from "@keepsake/observability/capture";
import { FeedQuery, type FeedPage, type RadiusMi } from "@keepsake/contracts/feed";
import type { PublicListing } from "@keepsake/contracts/listing";
import type { AspectShelf, ShelvesResponse } from "@keepsake/contracts/shelves";
import { boundingBox, haversineMiles, type LatLng } from "@keepsake/contracts/geo";
import type { Env } from "../env.js";
import { shelfMinItems } from "../env.js";
import { ok, fail } from "../lib/respond.js";
import { validateQuery } from "../middleware/validate.js";
import { burst } from "../middleware/rateLimit.js";
import { lookupPostalCode } from "../geo/lookup.js";
import { serializePublicListing, type FeedListingRow } from "../lib/serialize.js";
import { fetchAspectRowsForListings, fetchPhotoRowsForListings } from "../lib/listingsDb.js";
import { sanitizeFtsQuery } from "../db/fts.js";
import { fetchCandidateRows } from "../search/candidateRows.js";
import { vectorSearchCandidates, type VectorMatch } from "../search/search.js";
import { decodeKeysetCursor, decodeOffsetCursor, encodeKeysetCursor, encodeOffsetCursor } from "../lib/cursor.js";

type Vars = { validatedQuery: FeedQuery };
export const feedRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

/** Search and geo modes paginate by offset rather than keyset — simpler to
 * reason about for result sets this small (plan: "radius and search result
 * sets are small enough that offset's O(n) cost doesn't matter"). Bounding
 * it means a client can't force an unbounded `OFFSET` scan by walking
 * `next_cursor` forever. */
const MAX_OFFSET = 200;

/** SQL-level cap on geo-mode candidates fetched before the Worker's
 * haversine filter narrows the bounding box down to the true circle. Bigger
 * than `MAX_OFFSET + limit` ever needs to be, so the offset window below
 * never runs out of candidates before hitting `MAX_OFFSET` itself. */
const GEO_CANDIDATE_LIMIT = 500;

/** Typed `RadiusMi` rather than left as a bare number so the comment at the
 * call site — "25 mi, itself one of RADIUS_OPTIONS" — is checked instead of
 * asserted. `radius_mi` is schema-validated against `RADIUS_OPTIONS`, so a
 * default outside that set would be a radius the API uses and refuses. Drop
 * 25 from the options and this line stops compiling. */
const DEFAULT_RADIUS_MI: RadiusMi = 25;

const FEED_COLUMNS = "id, title, story, category, country, place_name, admin1, status, lat, lng, published_at, given_at";
/** Same columns, `l.`-qualified for the two query shapes that join
 * `listings_fts` to `listings l` by rowid. */
const FEED_COLUMNS_L = FEED_COLUMNS.split(", ")
  .map((column) => `l.${column}`)
  .join(", ");

/** SQL-level cap on FTS rows fetched to merge into a vector result set
 * (issue #180). Same reasoning as `GEO_CANDIDATE_LIMIT`: bigger than
 * `MAX_OFFSET + limit` ever needs to be, so the offset window can't run out
 * of merged candidates before hitting `MAX_OFFSET` itself. */
const FTS_MERGE_CANDIDATE_LIMIT = 500;

/**
 * Every `listings_fts MATCH` in this file runs through here (issue #163).
 *
 * FTS5 answers a query string its grammar can't parse with a driver-level
 * error; nothing between here and `app.onError` caught it, so a malformed
 * `q=` came back as a **500 whose body carried the raw D1 driver message**.
 * `db/fts.ts` no longer produces such a string — every token is a quoted
 * FTS5 literal — but "the sanitizer is correct today" is exactly the kind of
 * claim this project has been burned by, so a slip degrades to an empty
 * result set (and a captured exception) rather than a 500 in a visitor's
 * face.
 *
 * Deliberately narrow: only the MATCH-bearing statements go through this, so
 * a genuine D1 outage on any other query still surfaces as an error instead
 * of being silently turned into "no results".
 */
async function runFtsQuery(env: Env, sql: string, params: unknown[]): Promise<FeedListingRow[]> {
  try {
    const { results } = await env.DB.prepare(sql)
      .bind(...params)
      .all<FeedListingRow>();
    return results;
  } catch (err) {
    console.error("feed: FTS MATCH failed, degrading to empty results", {
      error: err instanceof Error ? err.message : String(err),
    });
    captureException(err, { tags: { route: "feed", stage: "fts_match" } });
    return [];
  }
}

/** FTS candidates in `bm25` order, no offset — the merge half of issue #180
 * needs the whole candidate window at once so it can be appended to a vector
 * result set and paginated as one list. */
async function fetchFtsMergeRows(env: Env, ftsQuery: string, category: string | undefined): Promise<FeedListingRow[]> {
  const conditions = ["l.status = 'approved'"];
  const params: unknown[] = [ftsQuery];
  if (category) {
    conditions.push("l.category = ?");
    params.push(category);
  }
  params.push(FTS_MERGE_CANDIDATE_LIMIT);

  return runFtsQuery(
    env,
    `SELECT ${FEED_COLUMNS_L}
     FROM listings_fts JOIN listings l ON l.rowid = listings_fts.rowid
     WHERE listings_fts MATCH ? AND ${conditions.join(" AND ")}
     ORDER BY bm25(listings_fts)
     LIMIT ?`,
    params,
  );
}

/** Appends rows the vector path didn't already return, preserving both
 * orders: vector rank first, then `bm25` rank for the FTS-only additions.
 * This is what stops a listing with no vector (a failed embed — issue #180)
 * from being invisible to a query that any *other* listing matched
 * semantically. */
function mergeUnseenRows(ordered: FeedListingRow[], extra: FeedListingRow[]): FeedListingRow[] {
  const seen = new Set(ordered.map((row) => row.id));
  const merged = [...ordered];
  for (const row of extra) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }
  return merged;
}

async function serializePage(env: Env, rows: FeedListingRow[], distances?: Map<string, number>): Promise<PublicListing[]> {
  const ids = rows.map((row) => row.id);
  const [photosByListing, aspectsByListing] = await Promise.all([
    fetchPhotoRowsForListings(env, ids),
    fetchAspectRowsForListings(env, ids),
  ]);
  return rows.map((row) =>
    serializePublicListing(row, photosByListing.get(row.id) ?? [], aspectsByListing.get(row.id) ?? [], distances?.get(row.id)),
  );
}

async function buildDefaultFeed(env: Env, query: FeedQuery): Promise<FeedPage<PublicListing>> {
  const limit = query.limit;
  const cursor = decodeKeysetCursor(query.cursor);

  const conditions = ["status = 'approved'"];
  const params: unknown[] = [];
  if (query.category) {
    conditions.push("category = ?");
    params.push(query.category);
  }
  if (cursor) {
    conditions.push("(published_at < ? OR (published_at = ? AND id < ?))");
    params.push(cursor.publishedAt, cursor.publishedAt, cursor.id);
  }
  params.push(limit);

  const { results } = await env.DB.prepare(
    `SELECT ${FEED_COLUMNS} FROM listings WHERE ${conditions.join(" AND ")} ORDER BY published_at DESC, id DESC LIMIT ?`,
  )
    .bind(...params)
    .all<FeedListingRow>();

  const items = await serializePage(env, results);
  const last = results.at(-1);
  const next_cursor = results.length === limit && last ? encodeKeysetCursor(last.published_at ?? 0, last.id) : null;
  return { items, next_cursor };
}

async function buildSearchFeed(env: Env, query: FeedQuery, ftsQuery: string): Promise<FeedPage<PublicListing>> {
  const limit = query.limit;
  const offset = decodeOffsetCursor(query.cursor);
  if (offset >= MAX_OFFSET) return { items: [], next_cursor: null };

  const conditions = ["l.status = 'approved'"];
  const params: unknown[] = [ftsQuery];
  if (query.category) {
    conditions.push("l.category = ?");
    params.push(query.category);
  }
  params.push(limit, offset);

  const results = await runFtsQuery(
    env,
    `SELECT ${FEED_COLUMNS_L}
     FROM listings_fts JOIN listings l ON l.rowid = listings_fts.rowid
     WHERE listings_fts MATCH ? AND ${conditions.join(" AND ")}
     ORDER BY bm25(listings_fts)
     LIMIT ? OFFSET ?`,
    params,
  );

  const items = await serializePage(env, results);
  const nextOffset = offset + limit;
  const next_cursor = results.length === limit && nextOffset < MAX_OFFSET ? encodeOffsetCursor(nextOffset) : null;
  return { items, next_cursor };
}

/** Same offset pagination as `buildSearchFeed`, but the ranked candidate
 * list came back from Vectorize (`vectorSearchCandidates`) rather than only
 * from a `bm25` SQL query — see the module doc comment for how the two are
 * combined.
 *
 * Issue #180: FTS rows are **merged in after** the vector-ranked ones rather
 * than the route picking one path per query. A listing whose embedding call
 * failed has no vector at all, and `reembedListing` is fire-and-forget, so
 * under the old "vector or FTS, never both" rule that listing was absent
 * from its own exact-title search for as long as any *other* listing cleared
 * `MIN_SCORE`. Merging makes a missing vector cost that listing its ranking,
 * not its existence. */
async function buildVectorSearchFeed(
  env: Env,
  query: FeedQuery,
  matches: VectorMatch[],
  ftsQuery: string | null,
): Promise<FeedPage<PublicListing>> {
  const limit = query.limit;
  const offset = decodeOffsetCursor(query.cursor);
  if (offset >= MAX_OFFSET) return { items: [], next_cursor: null };

  const rowsById = await fetchCandidateRows(
    env,
    FEED_COLUMNS,
    matches.map((match) => match.id),
    { category: query.category },
  );
  const vectorOrdered = matches
    .map((match) => rowsById.get(match.id))
    .filter((row): row is FeedListingRow => row !== undefined);

  const ordered = ftsQuery
    ? mergeUnseenRows(vectorOrdered, await fetchFtsMergeRows(env, ftsQuery, query.category))
    : vectorOrdered;

  const page = ordered.slice(offset, offset + limit);
  const items = await serializePage(env, page);
  const nextOffset = offset + limit;
  const hasMore = ordered.length > nextOffset;
  const next_cursor = hasMore && nextOffset < MAX_OFFSET ? encodeOffsetCursor(nextOffset) : null;
  return { items, next_cursor };
}

/**
 * The bounding-box candidate query shared by the two geo paths: plain radius
 * browse (`ftsQuery === null`, newest first) and FTS-ranked geo search
 * (`bm25` order). `buildVectorGeoFeed` calls it too, with a non-null
 * `ftsQuery`, to merge FTS matches into a vector result set (issue #180).
 *
 * The bind list here is fixed-width (at most one MATCH + four bbox bounds +
 * one category + the limit = 7), unlike the `id IN (…)` shape that issue
 * #186 was about — nothing accumulates per candidate.
 */
async function fetchGeoRows(
  env: Env,
  ftsQuery: string | null,
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number },
  category: string | undefined,
): Promise<FeedListingRow[]> {
  const whereParts: string[] = [];
  const params: unknown[] = [];
  let fromClause = "listings l";

  if (ftsQuery) {
    fromClause = "listings_fts JOIN listings l ON l.rowid = listings_fts.rowid";
    whereParts.push("listings_fts MATCH ?");
    params.push(ftsQuery);
  }
  whereParts.push("l.status = 'approved'");
  whereParts.push("l.lat BETWEEN ? AND ?");
  params.push(bbox.minLat, bbox.maxLat);
  whereParts.push("l.lng BETWEEN ? AND ?");
  params.push(bbox.minLng, bbox.maxLng);
  if (category) {
    whereParts.push("l.category = ?");
    params.push(category);
  }
  params.push(GEO_CANDIDATE_LIMIT);

  const orderClause = ftsQuery ? "ORDER BY bm25(listings_fts)" : "ORDER BY l.published_at DESC";
  const sql = `SELECT ${FEED_COLUMNS_L}
     FROM ${fromClause}
     WHERE ${whereParts.join(" AND ")}
     ${orderClause}
     LIMIT ?`;

  // Only the MATCH-bearing shape gets the degrade-to-empty treatment; a
  // plain geo browse has no user-controlled query grammar in it, so a
  // failure there is a real error and must stay one.
  if (ftsQuery) return runFtsQuery(env, sql, params);

  const { results } = await env.DB.prepare(sql)
    .bind(...params)
    .all<FeedListingRow>();
  return results;
}

/** Handles both geo-only and geo+search: `ftsQuery` is `null` for a plain
 * radius browse, or a sanitized FTS5 query when `q` is also given. Either
 * way the SQL layer only narrows to the bounding box (cheap, indexed via
 * `listings_geo`); the exact circle is enforced here with
 * `haversineMiles`, since a box is not a circle and D1 has no trig
 * functions to do it in SQL. */
async function buildGeoFeed(
  env: Env,
  query: FeedQuery,
  refPoint: LatLng,
  radiusMi: number,
  ftsQuery: string | null,
): Promise<FeedPage<PublicListing>> {
  const limit = query.limit;
  const offset = decodeOffsetCursor(query.cursor);
  if (offset >= MAX_OFFSET) return { items: [], next_cursor: null };

  const bbox = boundingBox(refPoint.lat, refPoint.lng, radiusMi);
  const results = await fetchGeoRows(env, ftsQuery, bbox, query.category);

  const withDistance = results
    .map((row) => ({ row, distanceMi: haversineMiles(refPoint, { lat: row.lat, lng: row.lng }) }))
    .filter((entry) => entry.distanceMi <= radiusMi);

  // Plain geo browse sorts by distance then recency. Search+geo keeps the
  // SQL-level `bm25` relevance order (preserved by `.map`/`.filter`, both
  // order-preserving) — geo is a filter on top of search here, not a
  // re-ranking, matching docs/design/feed.md's "FTS candidates filtered by
  // bbox/haversine".
  if (!ftsQuery) {
    withDistance.sort((a, b) => a.distanceMi - b.distanceMi || (b.row.published_at ?? 0) - (a.row.published_at ?? 0));
  }

  const page = withDistance.slice(offset, offset + limit);
  const distances = new Map(page.map((entry) => [entry.row.id, entry.distanceMi]));
  const items = await serializePage(
    env,
    page.map((entry) => entry.row),
    distances,
  );

  const nextOffset = offset + limit;
  const hasMore = withDistance.length > nextOffset;
  const next_cursor = hasMore && nextOffset < MAX_OFFSET ? encodeOffsetCursor(nextOffset) : null;
  return { items, next_cursor };
}

/** `buildGeoFeed`'s vector-search counterpart: candidates come from
 * `vectorSearchCandidates` instead of an FTS `MATCH`, filtered to the
 * bounding box + true circle exactly the same way, and — like
 * `buildGeoFeed`'s own search+geo branch — kept in vector-score order
 * rather than re-sorted by distance, since geo is a filter on top of
 * search here, not a re-ranking. */
async function buildVectorGeoFeed(
  env: Env,
  query: FeedQuery,
  refPoint: LatLng,
  radiusMi: number,
  matches: VectorMatch[],
  ftsQuery: string | null,
): Promise<FeedPage<PublicListing>> {
  const limit = query.limit;
  const offset = decodeOffsetCursor(query.cursor);
  if (offset >= MAX_OFFSET) return { items: [], next_cursor: null };

  const bbox = boundingBox(refPoint.lat, refPoint.lng, radiusMi);
  const rowsById = await fetchCandidateRows(
    env,
    FEED_COLUMNS,
    matches.map((match) => match.id),
    { category: query.category, bbox },
  );

  const vectorOrdered = matches
    .map((match) => rowsById.get(match.id))
    .filter((row): row is FeedListingRow => row !== undefined);

  // Issue #180, geo half: same merge as `buildVectorSearchFeed`, against the
  // bounding-box-filtered FTS candidates so an un-embedded listing is still
  // reachable by a location-plus-search browse.
  const ordered = ftsQuery
    ? mergeUnseenRows(vectorOrdered, await fetchGeoRows(env, ftsQuery, bbox, query.category))
    : vectorOrdered;

  const withDistance = ordered
    .map((row) => ({ row, distanceMi: haversineMiles(refPoint, { lat: row.lat, lng: row.lng }) }))
    .filter((entry) => entry.distanceMi <= radiusMi);

  const page = withDistance.slice(offset, offset + limit);
  const distances = new Map(page.map((entry) => [entry.row.id, entry.distanceMi]));
  const items = await serializePage(
    env,
    page.map((entry) => entry.row),
    distances,
  );

  const nextOffset = offset + limit;
  const hasMore = withDistance.length > nextOffset;
  const next_cursor = hasMore && nextOffset < MAX_OFFSET ? encodeOffsetCursor(nextOffset) : null;
  return { items, next_cursor };
}

// Launch audit finding 9: `RL_READ` was declared in all three environment
// blocks of wrangler.toml and used by nothing — `grep -rn 'burst(' apps/api/src`
// returned eight call sites and this was not among them, so every public read
// route had no rate limiting at all (320 parallel `GET /api/feed` from one
// address returned 320x 200). The cost of that is real but modest; the reason
// it mattered is the class of bug — a guard that looks like protection and has
// never once fired, which is the failure this repo keeps recording. Wired
// rather than deleted: reads are the cheapest thing to abuse and the only
// surface with no other brake in front of it (the write routes all have a KV
// daily budget behind their burst binding; reads have nothing).
feedRoutes.get("/", burst("RL_READ"), validateQuery(FeedQuery), async (c) => {
  const query = c.get("validatedQuery");

  let refPoint: LatLng | null = null;
  if (query.lat !== undefined && query.lng !== undefined) {
    refPoint = { lat: query.lat, lng: query.lng };
  } else if (query.country && query.postal) {
    const place = await lookupPostalCode(c.env, query.country, query.postal);
    if (!place) {
      return fail(c, "bad_request", "We don't know that postcode yet.", 400);
    }
    refPoint = { lat: place.lat, lng: place.lng };
  }

  // `radius_mi` is schema-validated to one of RADIUS_OPTIONS
  // (@keepsake/contracts/feed) or left unset, in which case 25 mi — itself
  // one of RADIUS_OPTIONS — is the default.
  const radiusMi = query.radius_mi ?? DEFAULT_RADIUS_MI;

  const ftsQuery = query.q !== undefined ? sanitizeFtsQuery(query.q) : null;

  // Vectorize first, per the issue: `vectorSearchCandidates` returns `null`
  // when it isn't safe to trust (no binding, the embedding call failed, or
  // Vectorize itself threw) and an array — possibly empty, after its own
  // relevance threshold — otherwise. Empty is deliberately still a
  // fallback: Vectorize always returns its nearest neighbors even when none
  // of them are actually relevant, so treating "matched nothing useful" the
  // same as "couldn't try" is what makes `db/fts.ts` a real fallback rather
  // than a path that only fires on an outage.
  //
  // `useVector` now decides only whether the vector ranking *leads*, not
  // whether FTS runs at all: both vector builders take `ftsQuery` and merge
  // the FTS matches in behind their own (issue #180).
  const vectorMatches = query.q !== undefined ? await vectorSearchCandidates(c.env, query.q) : null;
  const useVector = vectorMatches !== null && vectorMatches.length > 0;

  if (refPoint) {
    if (useVector) {
      return ok(c, await buildVectorGeoFeed(c.env, query, refPoint, radiusMi, vectorMatches, ftsQuery));
    }
    return ok(c, await buildGeoFeed(c.env, query, refPoint, radiusMi, ftsQuery));
  }
  if (useVector) {
    return ok(c, await buildVectorSearchFeed(c.env, query, vectorMatches, ftsQuery));
  }
  if (ftsQuery) {
    return ok(c, await buildSearchFeed(c.env, query, ftsQuery));
  }
  return ok(c, await buildDefaultFeed(c.env, query));
});

// --- Issue #39: browse-page shelves ---
//
// A shelf groups the current approved-listing set by a common aspect
// `name`/`value` pair. This is deliberately its own route rather than a
// parameter on `GET /api/feed` above: shelves are read from the same
// `status = 'approved'` universe but never subtract from it — the default
// feed handler above never joins `listing_aspects` and is untouched by
// anything below, which is what keeps issue #40's guarantee (a zero-aspect
// listing always surfaces) a structural fact about this file rather than a
// convention a later change to the default feed's WHERE clause could
// quietly break.
//
// Cost: naively, "the most common aspect values in the feed right now"
// means an aggregate GROUP BY over every approved listing's aspects on
// every browse-page load — cheap today at a few dozen listings, but a cost
// that scales with total catalogue size on every anonymous page view,
// unlike the default feed's indexed keyset scan. Rather than accept that
// silently or precompute on a cron this project has no scheduler slot free
// for, the aggregate is cached in KV (the same binding the moderation
// budgets and idempotency middleware already use) for
// `SHELF_CACHE_TTL_SECONDS`: at most one D1 aggregation per TTL window
// regardless of traffic, and a shelf lagging behind the newest listing by
// up to that long is an acceptable staleness for "common values" (unlike
// the default feed itself, which must be immediately consistent — a giver
// who just posted expects to see their own listing right away, which is
// exactly why shelves are never the only route to one). No active
// invalidation on listing create/approve: the TTL is short enough that
// wiring a KV delete into every status-changing route for a decorative,
// eventually-consistent grouping isn't worth the extra coupling.
const SHELF_CACHE_KEY_PREFIX = "feed:shelves:v1";
const SHELF_CACHE_TTL_SECONDS = 90;
/** Cap on how many distinct aspect values become shelves at all, so a
 * catalogue with many equally-common aspects doesn't turn the browse page
 * into an endless rail of shelves. */
const SHELF_MAX_COUNT = 6;
/** Preview slice per shelf — not pagination, just "enough to read as a
 * collection without loading the whole matching set on every page view." */
const SHELF_ITEMS_PER_SHELF = 12;

type ShelfAggregateRow = { name: string; value: string; count: number };

async function computeShelves(env: Env, minItems: number): Promise<ShelvesResponse> {
  const { results: aggregates } = await env.DB.prepare(
    `SELECT la.name AS name, la.value AS value, COUNT(*) AS count
     FROM listing_aspects la
     JOIN listings l ON l.id = la.listing_id
     WHERE l.status = 'approved'
     GROUP BY la.name, la.value
     HAVING COUNT(*) >= ?
     ORDER BY count DESC, la.name ASC, la.value ASC
     LIMIT ?`,
  )
    .bind(minItems, SHELF_MAX_COUNT)
    .all<ShelfAggregateRow>();

  const shelves: AspectShelf[] = await Promise.all(
    aggregates.map(async (aggregate): Promise<AspectShelf> => {
      const { results: rows } = await env.DB.prepare(
        `SELECT ${FEED_COLUMNS_L}
         FROM listing_aspects la
         JOIN listings l ON l.id = la.listing_id
         WHERE la.name = ? AND la.value = ? AND l.status = 'approved'
         ORDER BY l.published_at DESC, l.id DESC
         LIMIT ?`,
      )
        .bind(aggregate.name, aggregate.value, SHELF_ITEMS_PER_SHELF)
        .all<FeedListingRow>();

      const items = await serializePage(env, rows);
      return { name: aggregate.name, value: aggregate.value, count: aggregate.count, items };
    }),
  );

  return { shelves, min_items: minItems };
}

async function getShelvesCached(env: Env, minItems: number): Promise<ShelvesResponse> {
  // `minItems` in the cache key: a config change (a redeploy with a
  // different `SHELF_MIN_ITEMS`) takes effect on the next cache miss
  // instead of serving a response computed under the old floor for up to
  // `SHELF_CACHE_TTL_SECONDS` after the new value is already live.
  const cacheKey = `${SHELF_CACHE_KEY_PREFIX}:${minItems}`;
  const cached = await env.KV.get<ShelvesResponse>(cacheKey, "json");
  if (cached) return cached;

  const fresh = await computeShelves(env, minItems);
  await env.KV.put(cacheKey, JSON.stringify(fresh), { expirationTtl: SHELF_CACHE_TTL_SECONDS });
  return fresh;
}

feedRoutes.get("/shelves", burst("RL_READ"), async (c) => {
  const minItems = shelfMinItems(c.env);
  return ok(c, await getShelvesCached(c.env, minItems));
});

/**
 * `GET /api/feed` — three modes off one endpoint, per the plan's route
 * table and docs/design/feed.md:
 *
 *  - default: newest-first keyset on `(published_at DESC, id DESC)`.
 *  - `q`: semantic search first (`src/search/search.ts`, Vectorize +
 *    Workers AI embeddings, issue #38), ranked by vector score, bounded
 *    offset. Falls back to FTS5 (`src/db/fts.ts`), `bm25` order, when
 *    Vectorize is unavailable, embedding the query fails, or the vector
 *    search comes back with nothing useful — see `vectorSearchCandidates`
 *    (`src/search/search.ts`) and the `useVector` check in the route
 *    handler below for exactly which of those fired.
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
import { FeedQuery, type FeedPage } from "@keepsake/contracts/feed";
import type { PublicListing } from "@keepsake/contracts/listing";
import { boundingBox, haversineMiles, type LatLng } from "@keepsake/contracts/geo";
import type { Env } from "../env.js";
import { ok, fail } from "../lib/respond.js";
import { validateQuery } from "../middleware/validate.js";
import { burst } from "../middleware/rateLimit.js";
import { lookupPostalCode } from "../geo/lookup.js";
import { serializePublicListing, type FeedListingRow } from "../lib/serialize.js";
import { fetchAspectRowsForListings, fetchPhotoRowsForListings } from "../lib/listingsDb.js";
import { sanitizeFtsQuery } from "../db/fts.js";
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

const DEFAULT_RADIUS_MI = 25;

const FEED_COLUMNS = "id, title, story, category, country, place_name, admin1, status, lat, lng, published_at, given_at";
/** Same columns, `l.`-qualified for the two query shapes that join
 * `listings_fts` to `listings l` by rowid. */
const FEED_COLUMNS_L = FEED_COLUMNS.split(", ")
  .map((column) => `l.${column}`)
  .join(", ");

/**
 * Fetches full listing rows for a set of Vectorize match ids, filtered the
 * same way every other feed mode filters (`status = 'approved'`, optional
 * `category`, optional geo bounding box) — Vectorize itself knows nothing
 * about status or location, only similarity, so this is where a match
 * against a `pending`/`hidden`/`given` listing (the index isn't pruned by
 * status — see `search/reembed.ts`, it embeds regardless of status, the
 * same way `listings_fts`'s insert trigger does) gets excluded, exactly
 * like `buildSearchFeed`'s `l.status = 'approved'` join condition does for
 * FTS. Returned as a map so callers can re-apply the caller's own rank
 * order (`matches` is already sorted by vector score; `IN (...)` is not).
 */
async function fetchCandidateRows(
  env: Env,
  ids: string[],
  category: string | undefined,
  bbox?: { minLat: number; maxLat: number; minLng: number; maxLng: number },
): Promise<Map<string, FeedListingRow>> {
  if (ids.length === 0) return new Map();

  const placeholders = ids.map(() => "?").join(",");
  const conditions = ["status = 'approved'", `id IN (${placeholders})`];
  const params: unknown[] = [...ids];
  if (category) {
    conditions.push("category = ?");
    params.push(category);
  }
  if (bbox) {
    conditions.push("lat BETWEEN ? AND ?", "lng BETWEEN ? AND ?");
    params.push(bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng);
  }

  const { results } = await env.DB.prepare(`SELECT ${FEED_COLUMNS} FROM listings WHERE ${conditions.join(" AND ")}`)
    .bind(...params)
    .all<FeedListingRow>();
  return new Map(results.map((row) => [row.id, row]));
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

  const { results } = await env.DB.prepare(
    `SELECT ${FEED_COLUMNS_L}
     FROM listings_fts JOIN listings l ON l.rowid = listings_fts.rowid
     WHERE listings_fts MATCH ? AND ${conditions.join(" AND ")}
     ORDER BY bm25(listings_fts)
     LIMIT ? OFFSET ?`,
  )
    .bind(...params)
    .all<FeedListingRow>();

  const items = await serializePage(env, results);
  const nextOffset = offset + limit;
  const next_cursor = results.length === limit && nextOffset < MAX_OFFSET ? encodeOffsetCursor(nextOffset) : null;
  return { items, next_cursor };
}

/** Same offset pagination as `buildSearchFeed`, but the ranked candidate
 * list already came back from Vectorize (`vectorSearchCandidates`) instead
 * of a `bm25` SQL query — see the module doc comment for when this path is
 * used instead of FTS. */
async function buildVectorSearchFeed(env: Env, query: FeedQuery, matches: VectorMatch[]): Promise<FeedPage<PublicListing>> {
  const limit = query.limit;
  const offset = decodeOffsetCursor(query.cursor);
  if (offset >= MAX_OFFSET) return { items: [], next_cursor: null };

  const rowsById = await fetchCandidateRows(
    env,
    matches.map((match) => match.id),
    query.category,
  );
  const ordered = matches.map((match) => rowsById.get(match.id)).filter((row): row is FeedListingRow => row !== undefined);

  const page = ordered.slice(offset, offset + limit);
  const items = await serializePage(env, page);
  const nextOffset = offset + limit;
  const hasMore = ordered.length > nextOffset;
  const next_cursor = hasMore && nextOffset < MAX_OFFSET ? encodeOffsetCursor(nextOffset) : null;
  return { items, next_cursor };
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
  if (query.category) {
    whereParts.push("l.category = ?");
    params.push(query.category);
  }
  params.push(GEO_CANDIDATE_LIMIT);

  const orderClause = ftsQuery ? "ORDER BY bm25(listings_fts)" : "ORDER BY l.published_at DESC";
  const { results } = await env.DB.prepare(
    `SELECT ${FEED_COLUMNS_L}
     FROM ${fromClause}
     WHERE ${whereParts.join(" AND ")}
     ${orderClause}
     LIMIT ?`,
  )
    .bind(...params)
    .all<FeedListingRow>();

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
): Promise<FeedPage<PublicListing>> {
  const limit = query.limit;
  const offset = decodeOffsetCursor(query.cursor);
  if (offset >= MAX_OFFSET) return { items: [], next_cursor: null };

  const bbox = boundingBox(refPoint.lat, refPoint.lng, radiusMi);
  const rowsById = await fetchCandidateRows(
    env,
    matches.map((match) => match.id),
    query.category,
    bbox,
  );

  const withDistance = matches
    .map((match) => rowsById.get(match.id))
    .filter((row): row is FeedListingRow => row !== undefined)
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
  const vectorMatches = query.q !== undefined ? await vectorSearchCandidates(c.env, query.q) : null;
  const useVector = vectorMatches !== null && vectorMatches.length > 0;

  if (refPoint) {
    if (useVector) {
      return ok(c, await buildVectorGeoFeed(c.env, query, refPoint, radiusMi, vectorMatches));
    }
    return ok(c, await buildGeoFeed(c.env, query, refPoint, radiusMi, ftsQuery));
  }
  if (useVector) {
    return ok(c, await buildVectorSearchFeed(c.env, query, vectorMatches));
  }
  if (ftsQuery) {
    return ok(c, await buildSearchFeed(c.env, query, ftsQuery));
  }
  return ok(c, await buildDefaultFeed(c.env, query));
});

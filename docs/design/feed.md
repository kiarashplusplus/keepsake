# Feed

Status: `[TODO]` (M2).

`GET /api/feed?cursor&category&q&country&postal&lat&lng&radius&limit` serves three modes off one
endpoint: plain keyset (newest-first) when no location or query is given, FTS5 `q=` search, or
geo-radius when a postcode/coordinates are present. Only `status='approved'` (or `given`, on the
item page) is ever visible publicly.

## Geo mode

See [geo.md](./geo.md) for normalization and the radius query itself; the feed endpoint's job is
just wiring the resolved lat/lng + radius into the same bounding-box query the item detail step
uses live, so a giver sees the same place name a browser would.

## Search

FTS5 `MATCH` against `listings_fts` (title, story), sanitized terms (implicit AND, trailing `*`
for prefix matching so "grandmother" finds "grandmother's"), `bm25` ordering, bounded offset
pagination. `apps/api/src/db/fts.ts` is the single swap point to a plain `LIKE` fallback if D1's
FTS5-with-triggers setup misbehaves in practice (plan Risk #2) — nothing else in the codebase
should call FTS5 directly.

## Pagination

- Newest-first / category feed: keyset (`status, published_at DESC, id DESC`), no duplicates or
  gaps across pages by construction.
- Geo and search modes: bounded offset, max 200 results — radius and search result sets are
  small enough that offset's O(n) cost doesn't matter, and it's simpler to reason about than
  keyset-with-a-secondary-sort-key.

## Web: masonry + the signature card

- JS column assignment (1/2/3/4 columns at 0/520/820/1100px breakpoints), shortest-column
  placement using the API's `width`/`height` so layout is deterministic **before any image
  loads** — not CSS columns (re-flows on append) and not FlashList (no benefit on web). Pages of
  24, intersection-observer load-more.
- Card, the one signature moment repeated everywhere: photo (blurhash placeholder) → **one line
  of the story in Fraunces italic** (`storyExcerpt` token) → title in Inter → `place · distance`
  caption. Warm-tinted shadow, hairline border — never a flat, colorless card.

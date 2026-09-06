# Feed

Status: `[QA]` (M2 API side implemented; needs a real preview smoke test — feed browse, search, and radius against the live postal_codes seed — per M2 DoD).

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

## M2 status (API side)

`GET /api/feed` (`apps/api/src/routes/feed.ts`) implements all three modes described above:
default keyset (`src/lib/cursor.ts`'s `encodeKeysetCursor`/`decodeKeysetCursor`,
`base64url("<published_at>:<id>")`), FTS5 search (`src/db/fts.ts`'s `sanitizeFtsQuery` — implicit
AND, trailing `*` on the last token only, bare punctuation-stripped tokens), and geo radius
(bounding box from `@keepsake/contracts/geo`'s `boundingBox` on the `listings_geo` index, then
`haversineMiles` in the Worker to cut the box down to the true circle). `category` filters all
three; `q` + geo together fetch FTS-ranked candidates within the bounding box and filter them to
the circle without re-ranking (relevance order survives the geo filter). `given` listings never
appear (only `status='approved'`); given/hidden/pending are excluded and individually readable via
`GET /api/listings/:id` as before. Distance is rounded to one decimal on `PublicListing.distance_mi`.

`GET /item/:id` (`src/routes/item.ts`) reads the exported shell through `env.ASSETS`, injects
`og:title`/`og:description`/`og:image` (+width/height)/`og:url`/`twitter:card`/`<title>`/canonical
via `HTMLRewriter().on("head", { element })`, and serves the *unchanged* shell at 404 for any
non-public id — never confirming existence to a caller who can't see it, the same rule
`src/routes/images.ts` already followed for photos. `GET /sitemap.xml` (`src/routes/sitemap.ts`)
lists the four static pages plus every `approved` listing with `lastmod`; both routes only run at
all because `wrangler.toml`'s `run_worker_first` (and the vitest fixture's mirror in
`vitest.config.ts`) list `/item/*` and `/sitemap.xml` explicitly — otherwise the static-assets
system's SPA fallback would answer first.

Tests: `apps/api/test/feed.test.ts` (30-listing keyset pagination to the end with no duplicates,
category filter, given/hidden/pending exclusion, FTS "grandmother" → "grandmother's", 25 mi from
02144 includes 02139/Cambridge and excludes 01608/Worcester, lat/lng direct mode, bad-postcode
400), `test/item.test.ts` (OG tag injection, unknown/pending 404 with the shell unchanged),
`test/sitemap.test.ts`. One pre-existing contract bug found and fixed along the way:
`RadiusMiSchema` was a bare `z.union([z.literal(10), ...])`, which never matches a real
`?radius_mi=25` query value (always a string) — now `z.coerce.number().pipe(...)`, matching how
`lat`/`lng`/`limit` already coerce.

Also landed in this milestone (not feed browsing exactly, but the other public-facing write on a
listing): `POST /api/listings/:id/reports` — `ip_digest = sha256(day:ip)` (rotates daily, same
shape as `src/moderation/budget.ts`'s KV digest), unique per listing+digest (409 `conflict` on a
same-day repeat), and at `REPORT_AUTOHIDE_THRESHOLD` reports flips an `approved` listing to
`hidden` with a `moderation_events` row (`kind='report_autohide'`) — full detail in
`docs/design/moderation.md`'s decision-log shape, tested in `apps/api/test/reports.test.ts`.

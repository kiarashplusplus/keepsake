# Feed

Status: `[DONE]` — M2's DoD was walked against the live preview stack on 2026-09-06 (feed,
FTS search, postcode radius, item unfurl). Since then the endpoint also grew semantic search
behind `SEMANTIC_SEARCH` (#38, `docs/design/min-score-calibration.md`) and aspect shelves (#39),
with FTS5 kept as the fallback — and, since #180, as a *supplement* rather than only a fallback:
when the vector path leads, the FTS matches are merged in behind it (deduplicated by id) instead
of being skipped, so a listing whose embedding call failed loses ranking rather than disappearing
from search entirely. `listings.vector_indexed_at` is NULL for exactly those listings, which is
the queryable form of "has no current vector".

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
pagination. Sanitization splits the raw query on **every** non-alphanumeric character — exactly
what the `unicode61` tokenizer does to the stored text at index time — and wraps each token as a
quoted FTS5 string, so neither an apostrophe nor a bareword `OR`/`NEAR` can reach the query
grammar (#163). `apps/api/src/db/fts.ts` is the single swap point to a plain `LIKE` fallback if D1's
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
  of the story in Fraunces italic** (`storyExcerpt` token) → title → `place · distance` caption.
  Under v3 the card is a `Print` — white frame, taped corners, a deterministic per-id tilt, and
  Courier Prime for every caption and label. (This paragraph used to say "title in Inter"; Inter
  was removed from `packages/tokens` entirely by v3 — see
  [`design-system.md`](./design-system.md#v3--polaroids-on-a-table-2026-09-06).)

## M2 status (API side)

`GET /api/feed` (`apps/api/src/routes/feed.ts`) implements all three modes described above:
default keyset (`src/lib/cursor.ts`'s `encodeKeysetCursor`/`decodeKeysetCursor`,
`base64url("<published_at>:<id>")`), FTS5 search (`src/db/fts.ts`'s `sanitizeFtsQuery` — implicit
AND, trailing `*` on the last token only, every token a quoted FTS5 string built from
letters/digits alone; `?q=grandmother's ring` used to 500 the feed, because the sanitizer kept the
apostrophe and `'` is not a bareword character in FTS5's grammar, and every `MATCH` in
`routes/feed.ts` now also runs inside a `try`/`catch` that degrades to empty results rather than a
500 carrying the D1 driver message), and geo radius
(bounding box from `@keepsake/contracts/geo`'s `boundingBox` on the `listings_geo` index, then
`haversineMiles` in the Worker to cut the box down to the true circle). `category` filters all
three; `q` + geo together fetch FTS-ranked candidates within the bounding box and filter them to
the circle without re-ranking (relevance order survives the geo filter). `given` listings never
appear (only `status='approved'`); given/hidden/pending are all excluded from the feed, and of those only
`given` stays individually readable via `GET /api/listings/:id` — that route serves `approved` and
`given` and 404s everything else, so hidden and pending are not readable there (matching "only
`status='approved'` (or `given`, on the item page) is ever visible publicly" above). Distance is rounded to one decimal on `PublicListing.distance_mi`.

`GET /item/:id` (`src/routes/item.ts`) reads the exported shell through `env.ASSETS` — since
2026-09-08 the **item route's own** `dist/item/[id].html`, not `/`. That distinction did not exist
while every exported page shipped an empty body; now that the static export carries real markup
(`apps/web/src/ui/theme.tsx` explains what was emptying it), serving `/`'s HTML here would paint
the feed for the moment before hydration replaced it with a keepsake. If the assets binding ever
fails to match that path, its `single-page-application` not-found handling answers with
`index.html` at 200 — the old behaviour, degraded but working.

The same handler also inlines the **exact `PublicListing` JSON that `GET /api/listings/:id` would
return**, in a `<script type="application/json" id="ks-listing" data-id="…">`, and
`apps/web/src/features/item/inlineListing.ts` reads it instead of making that request: the route
has already read the row and the photos for the tags below, so the fetch the screen used to make
was asking the server for something it had just sent. It is the public projection (the same
`serializePublicListing` the API route uses — no owner id, no postcode), `<` is escaped so a story
cannot close the tag, and the payload is consumed once: the page is served `no-store` because a
listing can be given away between visits, so a second visit in the same session asks the server
again. A data block is never executed, so it needs no CSP hash — the same reasoning the shell's
JSON-LD records. `apps/api/test/item.test.ts` asserts the payload equals the API's own `data`, and
`apps/web/e2e/itemPayload.spec.ts` counts requests rather than timing the page.

The rewriter injects
`og:title`/`og:description`/`og:image` (+width/height)/`og:url`/`twitter:card`/`<title>`/canonical
and the plain `<meta name="description">` via `HTMLRewriter().on("head", { element })`, and serves
the *unchanged* shell at 404 for any
non-public id — never confirming existence to a caller who can't see it, the same rule
`src/routes/images.ts` already followed for photos. (The plain description was the one tag this
rewriter left alone until 2026-09-08, so every listing page in the sitemap carried the shell's
site-wide "Give a keepsake a second life." — the same sentence a search result would show for all
of them. It now comes from the same `storyExcerpt` as `og:description`.) `GET /sitemap.xml`
(`src/routes/sitemap.ts`) lists the four static pages plus every `approved` listing; only the
listings carry `<lastmod>`, from `listings.updated_at`. The static four used to be stamped with
the generation time, which told a crawler /about, /privacy and /terms had changed every ten
minutes forever — a `lastmod` that is always "now" is not a date, and Google's guidance is that it
disregards the field on a site whose dates it cannot trust, listings included. Both routes only run at
all because **production's** `run_worker_first` list (and the vitest fixture's mirror in
`vitest.config.ts`) names `/item/*`, `/sitemap.xml` and `/robots.txt` explicitly — otherwise the
static-assets system's SPA fallback would answer first. Dev and preview set
`run_worker_first = true`, a blanket boolean that gives every path the same treatment, so only
production exercises the list.

**Production only, since the launch audit (finding 2).** `/sitemap.xml` 404s on every environment
that is not production, `/robots.txt` is served by the Worker (`src/routes/robots.ts`, also listed
in `run_worker_first`) and returns a blanket `Disallow: /` off production, and every
non-production response carries `X-Robots-Tag: noindex, nofollow`. Preview used to build every
`<loc>` from its own `SITE_URL` and serve the production `Allow: /` file, which made
`preview.keepsake.ing` a crawlable, brand-named clone of the product whose notification email is
silently dropped. Production still serves `apps/web/public/robots.txt` — the Worker delegates to
the `ASSETS` binding — so that file remains the one place the production rules are edited.

`useFeed` (`apps/web/src/features/feed/useFeed.ts`) keeps page 1 of the last few queries in a
module-level cache for 60 seconds, so feed → keepsake → back is the list the visitor was looking
at rather than four skeletons and another round trip; `reloadToken` (the error banner's "Try
again") bypasses it, because an explicit ask for fresh data must not be answered from a cache. It
also passes an `AbortSignal` now — `getFeed` has always taken one and nothing passed it, so
typing in the search box left a trail of page-1 requests that were ignored on arrival but still
cost the visitor's connection, a Worker invocation and a D1 query each. And `loading` is no longer
`enabled && …`: while `app/index.tsx` waits for the saved location, the feed is loading, not
empty — reporting otherwise is what put "Nothing here yet. Be the first to give something." into
the exported HTML of `/`.

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

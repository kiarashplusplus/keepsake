# Build spec: share buttons, gift structured data, public feed

Grounded in `docs/seeding-and-distribution.md` §2/§5 and `docs/runbooks/seo-audit.md`. Nothing here
weakens the honesty rule — every listing stays a real object a real person hands over; this only
helps an already-approved listing travel further.

---

## 1. Share buttons on the item page

**Current state.** `apps/web/src/lib/share.ts`'s `shareListing()` only does `navigator.share()`
with a clipboard fallback — **no per-platform buttons exist** (no Facebook/X/WhatsApp/SMS/email
link anywhere). Wired into one "Share" button at `apps/web/app/item/[id].tsx:255`. Test:
`apps/web/test/lib/share.test.ts`. `apps/api/src/routes/item.ts` `buildOgTags()` (91–137) already
emits `og:type/site_name/locale/title/description/url` plus, when a photo exists,
`og:image(+secure_url/type/width=1200/height=630/alt)` and `twitter:card=summary_large_image` +
`twitter:image` — 1200×630 card (`apps/api/src/og/card.ts:52-53`), pinned by
`apps/api/test/item.test.ts:36-102`. **CSP** (`apps/api/src/middleware/securityHeaders.ts`,
`apps/web/public/_headers`): `frame-ancestors 'none'`, hashed `script-src`, no restriction on
anchor-driven top-level navigation — `connect-src`/`script-src`/`frame-src` govern subresource
loads and framing, not where a plain `<a href>` navigates. **Confirmed fine.**

**Gaps.** (1) No explicit share buttons — Web Share isn't available on every desktop browser, and
§2's playbook wants a person able to carry a listing into a Facebook group specifically via
`sharer.php`. (2) No `twitter:title`/`twitter:description` — X's card renderer is long documented
to prefer `twitter:*` and fall back to `og:*` (X's own card docs 402'd on live fetch this session,
so treat as established-but-not-freshly-verified); since `og:title/description` are always
present, X almost certainly already renders correctly, but adding the explicit tags removes the
"almost." Slack/Discord unfurl from plain OG with no extra requirement — no gap. iMessage builds
its preview client-side from the same OG tags — no new tags needed for it.

**Proposed change.** Add explicit share links, all plain `<a target="_blank" rel="noopener
noreferrer">` (never `window.open()`, to dodge Safari's non-click-handler popup block):

| Target | URL |
|---|---|
| Facebook | `https://www.facebook.com/sharer/sharer.php?u=<encodeURIComponent(url)>` — no `quote=` param honored since ~2018; Facebook reads title/description/image from the page's own OG tags, already correct. |
| X | `https://twitter.com/intent/tweet?text=<encodeURIComponent(shareText(title))>&url=<encodeURIComponent(url)>` |
| WhatsApp | `https://wa.me/?text=<encodeURIComponent(shareText(title)+" "+url)>` (current documented "click-to-chat" form; `api.whatsapp.com/send?text=` is the older equivalent — pick one, `wa.me`) |
| SMS | `sms:?&body=<encodeURIComponent(...)>` — `sms:?&body=` is the documented cross-platform form (iOS ignores the leading `?`; Android requires it) |
| Email | `mailto:?subject=...&body=...` |
| Web Share | keep existing `shareListing()` as the primary action where supported |
| Copy link | promote the existing clipboard fallback to its own always-visible button |

Add `twitter:title`/`twitter:description` (mirroring `og:title`/`og:description`) to
`buildOgTags()` — plain `<meta>`, `escapeHtml`'d, no CSP hash needed.

**Files touched.** `apps/web/src/lib/share.ts` (URL builders), `apps/web/app/item/[id].tsx` (UI
row), new `apps/web/src/features/item/ShareSheet.tsx`, `apps/api/src/routes/item.ts` (two tags).

**Tests.** `apps/web/test/lib/share.test.ts` — one case per builder (encoding of spaces/`&`/`#`);
`apps/api/test/item.test.ts` — assert the two new tags match `og:title`/`og:description`; new
`e2e/` spec (style of `e2e/deepLinkColdLoad.spec.ts`) asserting each button's resulting `href`.

**Risks.** `sms:` syntax cannot be verified from this container — needs a real iOS/Android pass.
WhatsApp/Facebook cache unfurl images by URL with no flush API (already known, per `item.ts`'s own
`?v=` fingerprint comment) — unaffected by this change. Popup blockers avoided by using anchors,
not `window.open`.

**Effort.** Web builders + UI + tests 4–6h; API tags + test 1h; e2e 2h; device verification 1–2h
(needs a human). **Total ~8–11h.**

---

## 2. Structured data for a free item

**Current state.** `apps/api/src/routes/item.ts:139-206` `buildProductJsonLd()` already emits
`Product` + `Offer`: `price:"0"`, `priceCurrency` from `CURRENCY_BY_COUNTRY`
(`packages/contracts/src/geo.ts:42-45`, US/CA only), `availability` flipping
`InStock`→`SoldOut` on `given`, `PostalAddress` with `addressLocality`/`addressRegion?`/
`addressCountry` only — no `postal_code` (that field exists only on `OwnerListing`,
`packages/contracts/src/listing.ts:194-220`, never on `PublicListing`, 172-192). No `seller`,
`sku`, `recipient`, or any giver/requester identity anywhere. Pinned by
`apps/api/test/item.test.ts:277-352` (availability flip, region presence/absence, postcode-never-
present).

**Research (live-fetched this session).**
- Google's [merchant-listing structured data](https://developers.google.com/search/docs/appearance/structured-data/merchant-listing) states plainly: *"Unlike product snippets, merchant listing experiences require a price greater than zero."* Confirms `seeding-and-distribution.md`'s finding — `price:"0"` will never earn the Merchant Listing rich result. Expected and fine: Keepsake was never targeting Merchant Center (§2: "policy-excluded").
- Plain `Product`/`Offer` snippets carry no such >0 rule in that same doc; `price:"0"`+`priceCurrency` is syntactically valid schema.org and parses cleanly — whether Search chooses to render any rich result for it is Google's discretion and untested here (no live network access to the Rich Results Test itself).
- `availability` enum confirmed live: `InStock`, `OutOfStock`, `SoldOut`, `Discontinued`, `BackOrder`, `InStoreOnly`, `LimitedAvailability`, `OnlineOnly`, `PreOrder`, `PreSale`. Current `InStock`/`SoldOut` pair is correct — `OutOfStock` would wrongly imply restocking, `Discontinued` would wrongly imply the product line ended.
- [schema.org/GiveAction](https://schema.org/GiveAction) (confirmed live): describes a completed ownership transfer, requiring `object`/`recipient`/`agent`. Wrong fit for an item page describing something still offerable, and a `recipient` field is exactly the identity leak Keepsake must never emit. `DonateAction` not independently corroborated this session; it targets charitable/monetary donation semantics and has no established Search rich-result support.

**Recommendation: no structural change.** Keep `Product`+`Offer` exactly as emitted. Add one
comment documenting the Merchant-Listing non-goal (with the citation above) so a future
contributor doesn't "fix" `price:"0"` into a fake nonzero price.

**Files touched.** `apps/api/src/routes/item.ts` — one comment line.

**Tests.** None needed — `apps/api/test/item.test.ts:277-352` already pins the exact shape being
recommended.

**Risks.** None on the recommended path. The risk was in *not* checking: reading only
`seeding-and-distribution.md`'s summary could wrongly suggest the JSON-LD itself needs changing;
it doesn't, since Keepsake never emits a Merchant Center feed, only on-page structured data.

**Effort.** 0.5h.

---

## 3. Public feed of approved listings

**Current state.** No public syndication feed exists. `GET /api/feed`
(`apps/api/src/routes/feed.ts`) is the app's own internal feed API — full `FeedQuery`
(category/q/geo/cursor), returns `PublicListing[]`, no explicit `Cache-Control`, generic
`burst("RL_READ")`. `GET /sitemap.xml` (`apps/api/src/routes/sitemap.ts`) lists URL+`lastmod` per
`approved` listing only (line 8-10 excludes `given` on purpose), `public, max-age=600`,
production-only via `isProduction(c.env)`. Reusable building blocks already exist:
keyset/offset cursors (`apps/api/src/lib/cursor.ts`), geo query params
(`country`+`postal`|`lat`+`lng`+`radius_mi`, one of `RADIUS_OPTIONS=[10,25,50,100]`,
`packages/contracts/src/feed.ts:6`), and the bounding-box+haversine pipeline (`feed.ts:277-366`).

**Format choice.** **JSON Feed 1.1** at `GET /feed.json`, primary, plus an **RSS 2.0** mirror at
`GET /feed.xml` from the same row-fetch. Confirmed live ([jsonfeed.org 1.1](https://www.jsonfeed.org/version/1.1/)):
required `version`/`title`/`items`, item `id` required, `content_html`/`content_text` (one
required), optional `url`/`summary`/`image`/`date_published`/`date_modified`, and a `next_url`
pagination field that "must differ from `feed_url` and previous `next_url` values" — maps directly
onto the existing keyset cursor. RSS 2.0 covers the broadest set of generic scrapers/aggregators
(Freebie Alerts-style) with zero custom parsing. Atom adds nothing over RSS for this audience —
skip. `ItemList` JSON-LD is worth adding as an indexing signal later, not as the subscription
format itself. [Trash Nothing's OpenAPI](https://trashnothing.com/api/v1.4/trashnothing-openapi.yaml)
(fetched live) uses `post_id`/`title`/`content`/`url`/`type`/`latitude`/`longitude`/`date`/
`outcome` (null/satisfied/withdrawn/promised/expired)/`photos[]`, with geo params in meters and
page-based pagination. Mirror its field names inside a `_keepsake` extension object (e.g. an
`outcome`-shaped status) rather than adopting page-based pagination — Trash Nothing's page/offset
model skips or duplicates rows when new listings land mid-page, which Keepsake's keyset cursor
already avoids and should keep as the primary mechanism.

**Fields exposed:** `id`, `url` (`/item/:id`), `title`, `storyExcerpt(story,200)` as `summary`
(same function `item.ts` uses for `og:description`), `category` label, `place_name`, `admin1`,
`published_at`→`date_published`, cover photo URL+width/height, and `_keepsake.status`
(`approved`|`given`). **Withheld:** postcode (never on `PublicListing` — nothing to withhold that
isn't already absent), any giver/requester identity, and **exact** lat/lng — round to 2 decimal
places (~1.1km jitter) before emitting, a *new* privacy rule stricter than the geo-search
endpoint's internal full precision, since the feed only needs "found nearby," never "navigated to."
Flag for a `docs/product-decisions.md` sign-off — the one genuinely new privacy surface in this
spec.

**`given` transition.** Mark, don't silently drop. Default query (no `status` filter) returns
`approved` only, same as `sitemap.xml`'s rule. But a feed is a log a subscriber diffs against its
own state, not a point-in-time index — silently dropping a `given` item looks identical to it never
existing, so add a bounded `?status=given&since=<cursor>` query returning recent transitions with
`_keepsake.status`/`given_at`, mirroring Trash Nothing's `outcome` field. Consumers that don't ask
for it never see a `given` row in their normal poll.

**Pagination/caching/limits/robots.** Reuse `encodeKeysetCursor`/`decodeKeysetCursor` verbatim;
`next_url` = `${SITE_URL}/feed.json?cursor=...` plus active filters. `Cache-Control: public,
max-age=600`, same number as `sitemap.xml` and the same reasoning. Reuse `burst("RL_READ")`; flag
(don't guess) whether it needs a lower per-IP ceiling for bulk polling. Production-only, 404
elsewhere, mirroring `sitemapRoutes`'s exact gate (preview's `SITE_URL` is a preview host — the
same launch-audit-finding-2 mistake would repeat). Add explicit `Allow: /feed.json` / `/feed.xml`
to `apps/web/public/robots.txt`. Geo filtering reuses the feed's existing `country`+`postal`/
`lat`+`lng`+`radius_mi` params and pipeline verbatim — no new geo code. Sitemap stays the crawler
URL+lastmod signal; the feed is additive, cross-linked via JSON Feed's own `feed_url` field.

**Files touched.** New `apps/api/src/routes/publicFeed.ts` (JSON Feed + RSS); refactor
`apps/api/src/routes/feed.ts` to export its row-fetch builders for reuse (pure extraction, no
behavior change); `apps/api/src/lib/serialize.ts` (new feed-item serializer with lat/lng
rounding); `apps/web/public/robots.txt`; optional `<link rel="alternate">` in
`apps/web/app/+html.tsx`.

**Tests.** New `apps/api/test/publicFeed.test.ts`, modeled on `apps/api/test/sitemap.test.ts`'s
production-gate pattern and `apps/api/test/feed.test.ts`'s query-building tests: `given` excluded
by default / included+flagged under `status=given`, postcode absent, lat/lng rounded, `next_url`
round-trips through the existing cursor decoder, correct `Cache-Control`, 404 outside production.
Run the full existing `feed.test.ts` suite unchanged after the extraction refactor.

**Risks.** Extraction touches a file with real production traffic and five builder functions —
mitigate by making it a pure move, verified against the unchanged existing suite first. Geo
rounding is a new, unreviewed privacy decision. The `given`-transition query is speculative (no
consumer exists yet per §2 — "nobody will ingest it on day one") and can be deferred to a
follow-up, shipping the approved-only feed first. Rate-limit tuning needs real `RL_READ` numbers,
not a guess.

**Effort.** Route+JSON Feed 6–8h; RSS mirror 2–3h; `given`-transition query 2h (or defer);
geo-rounding + decision writeup 1h; tests 4h; robots+optional link tag 0.5h. **Total ~14–18h
(~11–15h if the transition query is deferred).**

---

## Checklist

- [ ] Explicit share links (Facebook `sharer.php`, X intent, WhatsApp, SMS, email) in `share.ts` + `item/[id].tsx`
- [ ] `twitter:title`/`twitter:description` in `item.ts`'s `buildOgTags()`
- [ ] Verify `sms:` body syntax on real iOS Safari + Android Chrome
- [ ] e2e coverage for each share button's resulting URL
- [ ] Comment documenting the Merchant-Listing `price>0` non-goal in `buildProductJsonLd()` (no code/schema change)
- [ ] `GET /feed.json` (JSON Feed 1.1) reusing `feed.ts`'s builders + `cursor.ts`'s keyset cursor
- [ ] `GET /feed.xml` (RSS 2.0) mirror from the same row-fetch
- [ ] Round lat/lng to 2dp in the feed serializer; get product sign-off
- [ ] Decide `given`-transition scope now vs. follow-up (`status=given&since=`)
- [ ] Gate both feed routes production-only, matching `sitemap.ts`
- [ ] `Cache-Control: public, max-age=600`; reuse `burst("RL_READ")`
- [ ] `Allow: /feed.json` / `/feed.xml` in `apps/web/public/robots.txt`
- [ ] New `apps/api/test/publicFeed.test.ts` modeled on `sitemap.test.ts` + `feed.test.ts`
- [ ] Optional: `<link rel="alternate">` in `+html.tsx`

## Sources

[Google merchant-listing structured data](https://developers.google.com/search/docs/appearance/structured-data/merchant-listing) ·
[Google Product structured data](https://developers.google.com/search/docs/appearance/structured-data/product) ·
[schema.org/GiveAction](https://schema.org/GiveAction) ·
[JSON Feed 1.1](https://www.jsonfeed.org/version/1.1/) ·
[Trash Nothing OpenAPI v1.4](https://trashnothing.com/api/v1.4/trashnothing-openapi.yaml) ·
[Facebook Sharing for Webmasters](https://developers.facebook.com/docs/sharing/webmasters/) ·
[Facebook sharing best practices](https://developers.facebook.com/docs/sharing/best-practices/) (image width guidance only — did not independently confirm 1200×630/1.91:1 as a Facebook-stated number; that figure is corroborated by this repo's own existing card + tests, not by Facebook's docs directly).
`developer.x.com` card docs and WhatsApp help pages returned HTTP 402 / no usable content on live fetch this session — the X twitter:*/og:* fallback, X intent-URL format, and `wa.me`/`api.whatsapp.com` formats are stated from established, long-stable public convention, not freshly re-verified; flagged rather than presented as newly confirmed.

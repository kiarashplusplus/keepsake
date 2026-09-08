# Discoverability audit — `keepsake.ing`, 2026-09-08

What a crawler, an unfurler and a returning visitor actually get from the production shell, the
Worker's `/item/:id` rewriter, the sitemap and the cache headers. Read alongside
`docs/runbooks/launch-audit.md` (2026-09-06), which covered the same surface from the security and
indexability side and whose finding 2 (preview was fully indexable) is where `/robots.txt` and
`/sitemap.xml` got their production-only rule.

**How this was audited, and its one real limit.** From a saved copy of the production `<head>`, the
repository at HEAD, and a local `expo export`. **The live site could not be reached from the agent
container** — `CONNECT keepsake.ing` answers `403`, the egress policy AGENTS.md describes — so
nothing here is a measurement of production's own bytes or its response headers. Where that
mattered, it is said in place.

---

## The one that looked worst and was not real

The saved copy carried `&#34;` and `&amp;&amp;` inside its `<script>`, `<style>` and
`application/ld+json` blocks. Taken at face value that is fatal three times over: browsers do not
decode HTML character references inside raw-text elements, so the JSON-LD would not parse, and
neither inline script would match its CSP `sha256-` hash — the theme/redirect script would be
refused, and every visitor would get a flash of the wrong theme with a console error and nothing
else.

**It is a capture artifact, not what production serves.** `pnpm --filter @keepsake/web export`
followed by reading `dist/index.html` gives **zero** occurrences of `&#34;` — the script, the CSS
and the JSON-LD are all raw — and `preflight --only csp-script-hash` computes the declared hash
from that same source and passes. The saved file is also pretty-printed (the `<title>` text on its
own line, `defer=""`), which is what an HTML serializer that escapes text nodes indiscriminately
produces. **No code change was made for this, and none is warranted.**

The thing that would settle it beyond doubt is one `curl -sS https://keepsake.ing/ | head -c 4000`
from somewhere that can reach the apex. That is a minute of Kiarash's time and is the only step
this audit could not do for itself.

## Fixed in this pass

| What | Where |
|---|---|
| Item pages carried the shell's site-wide `<meta name="description">` — "Give a keepsake a second life.", identical on every listing URL in the sitemap. Now rewritten from the listing's own `storyExcerpt`, the same sentence as `og:description`. | `apps/api/src/routes/item.ts` |
| The first-visit redirect dropped the query string, so `utm_*`/`gclid`/`fbclid` died on the one hop that only ever runs for a visitor who arrived from an ad or a shared link. Now `location.replace("/welcome" + location.search)`. | `apps/web/app/+html.tsx` (+ both CSP hash copies) |
| `/sitemap.xml` stamped `/`, `/about`, `/privacy` and `/terms` with the generation time — a `lastmod` that was always "now", re-asserted every ten minutes. Those four now carry no `lastmod`; the listings keep their real `updated_at`. | `apps/api/src/routes/sitemap.ts` |
| Fonts were served `max-age=31536000, immutable` under filenames with no content hash, so replacing one in place would leave returning visitors on the old file for up to a year, invisibly. Every `/fonts/*.ttf` URL now carries a `?v=` token hashed from the font bytes, and preflight's `fonts` check recomputes it. | `apps/web/app/+html.tsx`, `apps/site/public/site.css`, `apps/web/public/_headers`, `tools/preflight/preflight.mjs` |
| Two `rel="icon"` links, neither typed. Ours now declares `type`/`sizes`; Expo's generated `/favicon.ico` stays as the legacy fallback, and the comment says why there are two. | `apps/web/app/+html.tsx` |

Each guard was broken and watched to fail before being restored — the fonts check three ways
(replaced font bytes, a stale `FONT_VERSION`, a `site.css` reference with no token), and the CSP
hash change is what `preflight --only csp-script-hash` and
`apps/api/test/securityHeaders.test.ts` pin. `apps/api/test/fixtures/public/index.html` gained the
default description and OG tags the real shell ships, because the previous fixture had none: a test
asserting the rewriter *removes* the shell's description could not have failed against it.

## Deliberately not done, and what each would cost

**Prerendering the public pages** — *done in the second pass below.* It was never Expo: it was one
`return null` in the app's own root provider.

**WOFF2** — *done in the second pass below.* What was not done, and why, is glyph subsetting.

**A CSP reporting endpoint.** The policy has no `report-uri`/`report-to`, so a violation in a real
browser is visible only in that visitor's console — which is precisely how the
`www.googletagmanager.com` and `cloudflareinsights.com` incidents in `securityHeaders.ts`'s
comments stayed invisible. Adding one means an endpoint that accepts unauthenticated POSTs from
anywhere, so it needs a rate limit, a size cap and somewhere to put the reports; that is a small
feature, not a header edit. The Cloudflare `NEL`/`Report-To` headers already on the site report
*network* errors, not CSP violations — they are not this.

**The homepage `<title>` and description.** "Keepsake" / "Give a keepsake a second life." is the
brand voice, deliberately (`docs/design/design-system.md`). A search result gives roughly 60
characters of title, and this one spends them on the name alone. Changing it is a copy decision for
Kiarash, not a fix.

**`CF-Cache-Status: HIT` alongside `max-age=0, must-revalidate` on the shell.** Not a defect on the
face of it — those directives permit storage with revalidation, which is exactly what a `HIT` after
a successful revalidate looks like. Confirming what the edge is really doing needs a request to the
live site, which this audit could not make.

## Still true and worth not re-litigating

- No `<link rel="canonical">` and no `og:url` in `app/+html.tsx`. It is one shell shared by ~17
  exported routes; a homepage canonical in it declares every other route a duplicate of `/`.
  `/item/:id` gets a real one from the Worker, and `apps/site`'s static pages carry their own.
  `apps/web/test/guards/rootOpenGraph.test.ts` holds this.
- `style-src 'unsafe-inline'` stays: react-native-web writes layout as inline `style` attributes.
- The empty `ks-google-ads-id` meta is the kill switch (#175), not drift, and the absent Google
  reporting origins in `connect-src` follow from it.

---

# Second pass, 2026-09-08: the empty body, and what it was really costing

The first pass filed "the initial body is essentially empty" as a milestone-sized problem and left
it. It was one line, and everything below follows from finding it.

## `expo export` was not the problem

`app/+html.tsx` carried the diagnosis as a fact about the tooling — "despite `web.output:
"static"`, `expo export`'s per-route HTML ships an EMPTY body (a Suspense placeholder, no
prerendered markup — confirmed by reading `dist/index.html` after export, not assumed)". The
reading was right and the conclusion was wrong. `src/ui/theme.tsx`'s `ThemeProvider` returned
`null` until an async `localStorage` read resolved:

```tsx
if (!hydrated) return null;
```

Effects do not run in a static render, so `hydrated` was false for the whole of it, and every
exported page was an empty `<div id="root">` — not because Expo could not render the app, but
because the app rendered nothing when asked.

**The gate existed for a real reason**: without it a dark-mode visitor's first render would use the
light palette and flash. The way out is that the palette barely flips. Of ~40 colour tokens exactly
eight — `TABLE_TOKENS`, the table and the light on it — differ between light and dark. Those eight
are now CSS custom properties (`colorsWeb` in `@keepsake/tokens/colors`, declared by
`+html.tsx`'s `THEME_CSS`), every other token stays the literal it was, and the pre-hydration
script's `data-theme` picks the palette before the first paint. Server markup and client markup are
then byte-identical in both themes: nothing to gate, nothing to mismatch, no flash.

The same argument applied twice more, to the two other things whose *markup* depended on the theme
or on an animation frame:

- `KraftTable.web.tsx` switched `background-blend-mode` and `opacity` on `mode`. Both are now
  `var(--ks-grain-*)`.
- `Print` — the object the entire identity is made of — animated its entrance from a Reanimated
  shared value that starts at 0 and *is* the opacity. Static render, no effect, so every print in
  the HTML was `opacity: 0`: present and invisible. The web now has `Print.web.tsx`, whose entrance
  is a CSS animation that runs at the first paint with no JavaScript and that
  `prefers-reduced-motion` turns off in the stylesheet.

Measured on the export, `dist/index.html`'s `<body>`: **~130 bytes → 26,268 bytes**, and what is in
it is the header, the hero, the search field, the category chips, the location control and the
footer. `/welcome` ships the whole explainer; `/give` ships step one. `e2e/staticRender.spec.ts`
asserts this with `javaScriptEnabled: false`, which is the only honest way to state it — with
scripting on, a page that took two seconds and a page that was in the HTML look the same to a
passing test.

## Three things the empty body had been hiding

**`/item/:id` was serving the feed's HTML.** The Worker read `/` for its shell because, when every
page's body was empty, any of them would do. They are not empty now, so it reads
`dist/item/[id].html` instead — otherwise every shared keepsake link would paint the feed for the
moment before hydration.

**The feed said "Nothing here yet" in the exported HTML.** `useFeed` reported `loading: false` while
`enabled` was false — the window in which `app/index.tsx` reads the saved location out of storage —
so a feed that had not been asked for yet rendered the empty state: *"Nothing here yet. Be the
first to give something."* That sentence was baked into `/`'s HTML. Waiting for the location is
loading; it now says so, and the first paint is the skeleton prints.

**The Worker was making the client re-ask for a row it had just read.** `/item/:id` reads the
listing and its photos to build the share card's tags, then handed the browser a page whose first
act was to fetch the same listing. It now inlines the exact `PublicListing` JSON that
`GET /api/listings/:id` answers with, in a `<script type="application/json">` (a data block —
never executed, so no CSP hash, the same reasoning as the shell's JSON-LD), and the screen reads
it. `e2e/itemPayload.spec.ts` counts the requests rather than timing the page.

## Fonts

WOFF2, with the TTF kept as a second `src` entry — the fallback, and the byte-source
`ogCardFonts.test.ts` compares the OG card's Courier against. Uncompressed, the two preloaded faces
go **431,628 → 221,708 bytes**. The honest caveat, measured locally: a TTF served with Brotli is
already 199,171 bytes for Fraunces, so if the edge was compressing them the real saving is small —
WOFF2's actual virtue is that it does not depend on that question. Order is enforced: preflight's
`fonts` check fails a `.ttf` reference that is not preceded by its `.woff2`, because `src:` is an
ordered list and getting it backwards ships the big file to everyone while looking correct in a
diff.

**Not subsetted.** Fraunces covers 624 codepoints, all Latin, 190 of them Latin-1 and Latin
Extended-A — which is what spells Zoë, José and Łukasz. The stories here are written by strangers
about their own things; dropping accented Latin to save ~30% of the glyphs would mangle real
people's words in the one place this product is about.

## Still open, in the order I would take them

1. **Real server-side rendering of `/item/:id`'s content.** The payload is inlined but the markup
   still comes from hydration. The Worker has the row; rendering the title, story and cover into
   the HTML is the next real step, and the one that would make a shared link readable with no
   JavaScript at all.
2. **Route-level code splitting** (`asyncRoutes`) — *done, branch `seo/async-routes-web`.*
   `app.base.json`'s `expo-router` plugin entry took `{ "asyncRoutes": { "web": "production" } }`
   (schema confirmed against this repo's own `node_modules/expo-router/plugin/options.json`,
   expo-router 57.0.19 — `web` scoped so native is untouched in both dev and production, matching
   this option's own description: `"production"` is web-only regardless). The single 3.2MB entry
   bundle became 23 chunks — a small `__common`/`entry` pair every route needs plus one small chunk
   per route (`admin` 47,551 bytes, `give/details` 6,021, `welcome` 1,499, …).
   The honest result: the win is smaller than it looks from the entry bundle's size alone, because
   almost all of it is React/react-native-web/Expo Router runtime that every route needs regardless
   — not give-flow or admin code. `/welcome`'s own JS fell from 3,227,134 raw / 672,974 Brotli q5
   (the whole entry bundle) to 3,057,748 / 643,187 (`__common` + `entry` + its own tiny chunk): -5%
   raw, -4% compressed. Real `wrangler dev` + Lighthouse 13.4.1 on `/welcome` (mobile, simulated
   Slow 4G) agrees on Total Blocking Time (183ms → 65ms, -65%, since a route no longer parses code
   it will never run) but shows LCP *unchanged under real `--throttling-method=devtools` network
   throttling* (798ms before and after — the LCP text is in the static HTML either way, so it
   paints independent of which JS chunks are still loading) while `--throttling-method=simulate`
   (Lantern) reports LCP ~300ms worse after, which is most likely an artifact of local
   `wrangler dev` serving HTTP/1.1 (confirmed via `curl -I`) — more, smaller requests contending for
   Chrome's 6-connections-per-origin cap in Lantern's model — rather than something that would
   happen on Cloudflare's HTTP/2 production edge. 30 Playwright specs added
   (`e2e/deepLinkColdLoad.spec.ts`, both viewport projects) hard-load every exported route — give
   flow, `/item/:id`, `/mine`, `/mine/:id`, `/recover`, `/recover/:token`, `/withdraw/:token`,
   `/confirm/:token`, `/admin` — in a fresh browser context with no prior navigation, and all pass,
   alongside the rest of the suite (158 e2e specs, `pnpm -r typecheck`, `pnpm lint`, preflight).
3. **Bounding a long feed.** Pagination appends without limit and the masonry renders every card it
   has. Profile it with several hundred listings before choosing virtualisation — the current feed
   has nothing like that many.
4. **A pre-hydration feed prefetch.** The location preference the first query needs is in
   `localStorage`, which the pre-hydration script can already read, so `/api/feed` could be in
   flight before the bundle has finished downloading. It is a real cut to the waterfall and it
   changes the inline script's CSP hash; worth doing only with a measurement either side.
5. **Lighthouse, on the real site.** Everything above is reasoned from the artifact and the
   container's own measurements. None of it is a field measurement, and this container cannot make
   one.

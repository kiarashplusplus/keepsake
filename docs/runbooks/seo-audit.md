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
  `apps/web/test/guards/rootOpenGraph.test.ts` holds this. **Still true of the shell**, but the
  conclusion drawn from it here — that the other routes therefore get none — was wrong, and the
  third pass below fixes it: the exported *files* are per-route even though the component is not,
  so `scripts/seo-html.mjs` writes each one its own.
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

---

# Third pass, 2026-09-09: measured against production

The two passes above both open with the same caveat — the agent container could not reach
`keepsake.ing`, so everything in them is reasoned from the repository and a local `expo export`.
**That is no longer true.** `curl https://keepsake.ing/` answers `200` from the container now, and
this pass is the first one whose findings are the live site's own bytes, status codes and headers
rather than an inference about them.

It also answers the open question the first pass left at the top: `curl -sS https://keepsake.ing/ |
head -c 4000` shows the inline `<script>`, `<style>` and `application/ld+json` blocks **raw**, with
no `&#34;` anywhere. The saved-copy artifact was an artifact. Nothing to fix, and the question is
closed rather than deferred.

## What production was actually doing

| Measured on the live site | Status |
|---|---|
| `GET /nonexistent-page-xyz` → `200 text/html`, `ETag: "48d6c1fd…"` — byte-identical to `/`. So did `/sitemap`, `/Welcome`, and every other path nobody exported. | Fixed |
| No `<link rel="canonical">` and no `og:url` on any Expo route (`/`, `/welcome`, `/give`). `/about`, `/privacy`, `/terms` had both all along. | Fixed |
| `/welcome` and `/give` were live, indexable and **orphaned**: absent from `/sitemap.xml`, and linked from no crawlable markup on any page (the header/footer links are in-app navigations, so the only `href`s in the served HTML are `/`, `/about`, `/mine`, `/privacy`, `/terms`). | Fixed |
| `/give/details`, `/give/story`, `/give/review`, `/give/email` — four mid-flow form steps — each `200`, indexable, each carrying the site-wide description. | Fixed |
| `/_sitemap` — expo-router's built-in route index, which lists every route in the app including `/admin` and `/bulk` — live at `200`. | Fixed |
| `/welcome` unfurled as the site default ("Keepsake" / "Give a keepsake a second life.") while its own `<meta name="description">` was three sentences about the product. `RouteHead` writes `<title>` and `description`; the OG tags come from the shell and nothing rewrote them. | Fixed |
| Two opposite trailing-slash rules on one site: `/about/` → `307` → `/about`, but `/give` → `307` → `/give/`. All three static pages link `href="/give"`, so every "Give something" click and crawl cost a redirect hop. | Fixed |
| `www.keepsake.ing` → `301` → apex, `http://` → `301` → `https://`, `/item/<unknown>` → real `404`, `/mine` and `/recover` → `X-Robots-Tag: noindex, nofollow`. | Already right |

`/sitemap.xml` itself was well-formed and correct for what it listed — four URLs, no listings,
because production has no approved listings yet (`GET /api/feed` returns `items: []`). Nothing
below is a fix to the sitemap's *shape*; the `lastmod` reasoning from the first pass stands
unchanged.

## The soft 404, which is the one that mattered

`not_found_handling = "single-page-application"` answers **every** miss with `index.html` at
`200`. That is the correct setting for a client-routed app whose deep links must survive a hard
refresh, and it is why it was chosen. What it costs on a public site is that the site has an
unbounded supply of URLs that all resolve, all serve the homepage's exact bytes, and — with no
canonical anywhere on the Expo routes — offer a crawler nothing to consolidate them onto. Every
typo'd link, every stale inbound URL, every path a scraper invents is a live page. Google calls
these soft 404s and treats them as a crawl-budget and quality problem; here they were also
duplicates of the single page this product most wants ranked.

The fix is `not_found_handling = "404-page"` plus a real `dist/404.html`, which
`apps/web/scripts/seo-html.mjs` writes from expo-router's own `+not-found` export — so the page a
visitor lands on is exactly the one they saw before, now with a truthful status under it.

**What made that safe** is the part worth reading before touching it again. Five routes
(`/mine/:id`, `/recover/:token`, `/withdraw/:token`, `/confirm/:token`, `/bulk/:batchKey/…`) have
no file at their own path — Expo Router exports them under the literal `[param]` filename — and
were relying on the SPA fallback to come back at all. `apps/api/src/index.ts`'s catch-all now maps
each to its own exported shell (`DYNAMIC_ROUTE_SHELLS`). That is not merely restoring the old
behaviour: the fallback was handing them `index.html`, which is the **feed's** markup, so a hard
refresh of `/mine/abc` painted the header, search field and category chips for the moment before
hydration. It is the same defect the second pass fixed for `/item/:id`, for the five routes that
were left. `apps/api/test/notFound.test.ts` asserts both halves against the served bytes;
`e2e/deepLinkColdLoad.spec.ts` cold-loads every one of them in a real browser.

### What the soft 404 had been hiding

Turning the fallback off made one existing test fail, and it was not the test's fault.

`routes/ogCard.ts`'s `serveDefault` streams `/og-default.png` through the `ASSETS` binding when a
listing has no photo, and guards it with `if (!asset.ok) return fail(...)`. The api suite's fixture
tree has no `og-default.png` — so under `single-page-application` that fetch came back as
`index.html` at **200**, `asset.ok` was true, and the route streamed the SPA shell's HTML out under
`Content-Type: image/png`. The test asserted the status and the fallback header, both of which were
right, and never looked at the bytes. On a real deploy the same path would hand every unfurler the
homepage's HTML labelled as a PNG the moment that asset went missing — silently, since nothing
errors.

A 1×1 PNG now stands in for it (`apps/api/test/fixtures/public/og-default.png`, and that directory
gained a README explaining why), and the fallback exercises the code it was written for. Nothing in
`src/` changed for this: the guard was already correct, it just had nothing to guard against.

`/health`'s ASSETS probe was the other thing leaning on the fallback — it fetched `/index.html`
knowing any path would answer. It still fetches `/index.html`, but now that is a real file check
rather than a tautology. That it survives `drop-trailing-slash` (which redirects an *incoming*
`/index.html` to `/`) was verified against real workerd via `wrangler dev`, not assumed: a direct
binding fetch resolves by path and the trailing-slash rules do not apply to it. Miniflare's
emulation would not have distinguished the two.

## Where the per-route metadata lives now, and why not in the shell

`app/+html.tsx` still declares no canonical and no `og:url`, and
`test/guards/rootOpenGraph.test.ts` still holds that. The reasoning in the first pass's "still true
and worth not re-litigating" was right about the shell and wrong about the conclusion: the shell is
one file shared by ~17 routes, but the *exported files* are per-route. `scripts/seo-html.mjs` runs
after `fix-html-head.mjs` and writes, per file:

- `<link rel="canonical">` and `<meta property="og:url">` on the three indexable Expo routes
  (`/`, `/welcome`, `/give`), absolute, from the same hardcoded origin `+html.tsx` already uses for
  `og:image`.
- `og:title`/`og:description` rewritten **in place** — not appended, since a crawler takes the
  first it sees — on any page that carries its own `RouteHead` description. Today that is
  `/welcome`.
- `<meta name="robots" content="noindex, follow">` on every other exported page: the give flow's
  interior steps, `/admin`, `/bulk*`, `/mine*`, `/recover`, the `[param]` routes and the 404 page.
  `follow`, not `nofollow` — these pages carry the shared header and footer and there is no reason
  to dead-end a crawl at them.
- `_sitemap.html` deleted outright. Noindexing it would leave it fetchable and linkable, and it is
  a development affordance.

**The one file that must never be touched** is `dist/item/[id].html`. It is the shell the Worker
rewrites into every listing page, and its rewriter removes the shell's `title`, `description`,
`og:*`, `twitter:*` and canonical — but not a robots meta. One landing there would deindex every
listing on the site from what reads in a diff like adding a route to a list, with nothing failing
at runtime and nothing in the export log. `NEVER_TOUCH` is the guard and
`test/guards/seoHtml.test.ts` is what holds it.

The script defaults an unknown route to `noindex`, so a new route has to be added to `INDEXABLE`
on purpose. For an app with three indexable Expo pages and twenty flow steps behind a token, that
is the safe direction — but it is the direction that makes the mistake above cheap, hence the
guard.

## One trailing-slash rule

`html_handling = "drop-trailing-slash"` (from the default `auto-trailing-slash`) in all three
`[assets]` blocks. Under the default, a route exported as `dist/give/index.html` is canonical at
`/give/` while `dist/welcome.html` is canonical at `/welcome` — the site had two opposite rules
depending on an export detail nobody chose. Now no page URL ends in a slash except `/`, which is
what `apps/site/public/*.html` already link to, what the sitemap lists, and what the canonicals
say. `apps/api/test/assetsHandlingConfig.test.ts` asserts both keys agree across all three blocks,
because wrangler inherits neither into a named environment and "set it at the top level and forget
the other two" is silent.

## The finding this pass did NOT act on, and why it needs Kiarash

**`/` very likely resolves to `/welcome` for Googlebot, and that is a product decision, not a
bug.** `+html.tsx`'s pre-hydration script redirects a first-time visitor from `/` to `/welcome`,
where "first-time" means neither `keepsake.ownerToken.v1` nor `keepsake.visited.v1` is in
`localStorage`. Google's Web Rendering Service executes page JavaScript and is explicitly stateless
across page loads — it clears local and session storage — so every render of `/` is a first visit,
`location.replace("/welcome" + location.search)` fires, and Google follows a JS-initiated
`location.replace` as a redirect. The most valuable URL this product has would then be recorded as
a redirect to `/welcome`, and `/welcome` is what ranks for the brand.

This was not measured — nothing in this container can drive Googlebot — and it is reasoned from
Google's documented renderer behaviour plus the script's own condition. Treat it as likely, not
certain; Search Console's URL Inspection on `https://keepsake.ing/` settles it in one click, and
that is the first thing to do with it.

It is not fixed here because every fix is a product change, not a technical one:

- **Show the explainer at `/` instead of navigating to it.** The first-time branch sets state
  rather than the URL, and `/welcome` stays a real linkable page. Keeps one canonical front door.
  The pre-hydration script would set an attribute the root route reads, so there is still no
  flash and no `Vary` — the reason that script exists at all (see its comment) is unaffected. This
  is the option I would take.
- **Drop the first-visit redirect** and let `/` always be the feed, with the explainer reached from
  a link. Simplest, and loses the thing the redirect was built for.
- **Leave it.** Defensible if `/welcome` ranking for the brand is acceptable — it is a good page
  and, as of this pass, a well-formed one.

What this pass did do is make the second-best outcome much less bad: if Google does settle on
`/welcome`, it now has its own canonical, its own `og:title`/`og:description` (it was unfurling as
the site default), and a place in the sitemap. Before this pass it had none of the three.

## Deliberately not done

**`robots.txt` still says `Allow: /`.** Adding `Disallow: /give/story` and friends would be
actively worse than the noindex meta now on those pages: a disallowed URL is never fetched, so the
noindex is never *seen*, and a URL Google finds linked from elsewhere can still be indexed
url-only. Crawl-and-noindex is the correct combination here, and it is what shipped.

**`/give`'s `<title>` is still "Give a keepsake: Photos — Keepsake".** It is a step name from
`GIVE_STEP_NAMES` and it reads like one in a search result. It is also the target of the "Give
something" call to action on all three static pages, so the page stays indexed; what its title
should say is a copy decision for Kiarash, the same call the first pass made about the homepage's.

**Real server-side rendering of `/item/:id`'s content** — unchanged, still item 1 below.

**301 instead of 307 on the canonicalising redirects.** `/index.html` → `/`, `/about.html` →
`/about`, `/welcome/` → `/welcome` are all `307`/`308` from Cloudflare's static-assets system, which
does not expose the status as a setting. `308` is permanent and consolidates the same as `301`;
the `307`s are for the drop-trailing-slash direction. Neither is worth a Worker hop on every
document request to change, and Google follows both.

## Still open, in the order I would take them

1. **Real server-side rendering of `/item/:id`'s content.** Unchanged from the second pass: the
   payload is inlined but the markup still comes from hydration.
2. **Bounding a long feed** — unchanged.
3. **A pre-hydration feed prefetch** — unchanged.
4. **Lighthouse on the real site.** Still not done, but no longer impossible from here: the
   container can reach production now. What it cannot do is install Chrome-for-Testing's pinned
   build, so a run from here would measure this container.
5. **Resubmit `/sitemap.xml` in Search Console after this deploys**, and watch the "Excluded →
   Soft 404" and "Duplicate without user-selected canonical" buckets drain. That is the field
   measurement none of these three passes has.

---

# Fourth pass, 2026-09-09: the redirect, measured by Google's own tool

The third pass ended on the one finding it did not act on: `/` "very likely resolves to `/welcome`
for Googlebot", reasoned from the renderer's documented statelessness and left for Kiarash, because
every fix was a product change. Kiarash ran PageSpeed Insights against `https://keepsake.ing/`
(2026-09-09, 12:28 AM) and got the answer without Search Console: **"Clientside Redirect! We
encountered an additional client-side redirect when loading the page … Updated URL
https://keepsake.ing/welcome."** SEO score 100, and the homepage a redirect. That is the
measurement the third pass could not make, and it settles the question in the direction it
predicted.

Production served `9035bbd` — the tip of `main` — throughout this pass, so everything the third
pass shipped (real 404s, per-route canonicals, `/welcome` and `/give` in the sitemap, one
trailing-slash rule) was live and re-confirmed against the apex: every sitemap URL answers `200`
with no hop; `/give/`, `/welcome/`, `/about/` and `/index.html` are one `307` each to their
canonical; `www.` and `http://` are `301`s; `/item/<unknown>`, `/_sitemap` and any invented path
are real `404`s. Nothing below touches the sitemap's shape.

## Fixed in this pass

**`/` no longer redirects anyone.** The pre-hydration script still decides, before the first
paint, whether this load of `/` is a device's first — but instead of `location.replace("/welcome"
+ location.search)` it now puts `data-ks-first-visit="1"` on `<html>`. `app/index.tsx` renders
**both** the explainer and the feed into `/`, inside one `Page`, and a two-line stylesheet in the
shell (`FIRST_VISIT_CSS`) shows one of them from that attribute. It is the same construction the
second pass used for the theme and the third for the viewport: decided in CSS from a value set
before JavaScript, on markup that is identical for every visitor. So:

- `/` answers `200` with its own content to Googlebot, to a no-JS crawler (which gets the feed —
  no attribute, no explainer) and to a human, and there is no hop for `utm_*`/`gclid` to die on.
- A first-time visitor still never sees a frame of the feed: the attribute is on `<html>` before
  the body is parsed. `e2e/welcome.spec.ts` asserts the URL stays `/`, that the feed is
  `display: none` rather than merely below the explainer, and — the assertion that matters for a
  page carrying two screens — that the browser console logs **no error**, which is where a React
  hydration mismatch would have shown up.
- `/welcome` is unchanged as a page: still in the sitemap, still its own canonical, still the
  explainer with a title and description. Nobody is sent there any more; `llms.txt` and the
  explainer's own copy link to it.
- The feed does not fetch, report `FeedViewed`, or rewrite the URL with `?radius_mi=25` while it is
  hidden behind the explainer; "See what's out there" clears the attribute and flips that gate, in
  place. `src/lib/firstVisit.ts` is the whole of the React side.

This is the option the third pass said it would take. What it costs is in
`docs/product-decisions.md`'s row: ~8 KB more HTML on `/`, and the explainer copy on two URLs.

**Every CTA is now a real link.** `Button` inside `<Link asChild>` rendered as a `<div
role="button">` that navigated on press, so the served HTML of `/` contained no `<a>` to `/give`
at all — the page this product converts on, in the sitemap, linked from nowhere a crawler could
see — and `/welcome` linked to neither `/` nor `/give`. `Button` now passes the `href` expo-router
hands it through to its Pressable, which react-native-web renders as an anchor with the link role.
Measured on the new export: `/` carries four `<a href="/give">` (both header widths, the hero, the
explainer) where production carries none. Left-clicks still go through the router; middle-click
and modifier-click open a tab, which they never could. Every spec that selected one of these by
`getByRole("button")` now says `link`, because that role change *is* the fix.

**Structured data and share metadata on the static pages.** `/about`, `/privacy` and `/terms`
declared `og:image` and nothing about it — no width, height, type or alt — and two of the three had
no `twitter:card`. They now match the shell tag for tag, and each carries the same `WebSite` and
`Organization` nodes the shell emits plus its own `AboutPage`/`WebPage` node linked to them by
`@id`. `test/guards/rootOpenGraph.test.ts` holds the three copies equal to `ROOT_JSON_LD` and each
page node's `url` equal to its canonical.

**The `Organization` has a `logo`**, and `/apple-touch-icon.png` exists. Both were withheld for
the same reason: the only square mark was the 64px favicon, Google wants ≥112, and iOS's request
for the touch icon answered `404` on production (measured). `tools/og/render-icons.mjs` renders
`icon-512.png` and a square 180px touch icon from the favicon's own SVG through resvg; the guard
reads the PNGs' real dimensions rather than the numbers in the markup.

## One thing found on `main` on the way

`main`'s CI was red at `9035bbd` (run 34316853033): `e2e/staticRender.spec.ts`'s new desktop
assertion `getByRole("link", { name: "About" })` matches the header's link *and* the footer's
(#224) and trips strict mode, in both projects. It is fixed here by asking for the first `/about`
anchor in the document, which is the header's at either width.

## Deliberately not done

- **`/give`'s `<title>`** is still "Give a keepsake: Photos — Keepsake", and its description is the
  site default. Same copy decision as the first and third passes left; now that `/give` is linked
  from four places on `/`, it is the next most valuable title on the site.
- **Dropping `/welcome` from the sitemap.** It is a near-duplicate of `/`'s first-visit state, but
  both self-canonicalise and `/` has strictly more content, so Google should keep them apart. If
  Search Console ever reports `/` as "Duplicate, Google chose different canonical" pointing at
  `/welcome`, that is the trigger — it is in the decision's row.
- **A Lighthouse run from here.** The container reaches production, but its Chromium is not the
  pinned build and the network is a proxy; a number from it would measure the container. PageSpeed
  Insights on `https://keepsake.ing/` after this deploys is the check, and the dialog in the
  screenshot should simply not appear.

## After this deploys

1. Re-run PageSpeed Insights on `https://keepsake.ing/` — no "Clientside Redirect" dialog, and the
   report should be for `/` itself.
2. In Search Console, inspect `https://keepsake.ing/`: it should render as the explainer with the
   feed in the DOM, not as a redirect.
3. Validate `https://keepsake.ing/about` in the Rich Results test: `AboutPage` + `WebSite` +
   `Organization` with a logo, no warnings.

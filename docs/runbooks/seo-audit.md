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

**Prerendering the public pages.** `dist/index.html` is a 22 KB shell whose `<body>` is
`<div id="root"><div …><!--$--><!--/$--></div></div>` — a Suspense placeholder and nothing else, on
every route, despite `web.output: "static"`. Everything a visitor reads arrives only after the
bundle downloads and executes. This is not "Google cannot index the site" — Google renders
JavaScript, and `/item/:id` already gets a real title, description, canonical, OG tags and a
`Product` JSON-LD from the Worker without running any JS — but it is slower for everyone, and every
non-rendering crawler and unfurler sees an empty document body. Fixing it properly means
server-rendering React Native Web through the Worker (a Worker hop on `/`, which
`wrangler.toml`'s own comment argues against) or generating real markup at export time for the
landing page and the feed. It is a milestone, not a patch, and it should be decided against real
numbers rather than against this paragraph.

**WOFF2, and whether both preloads are earning their place.** `Fraunces-VF.ttf` (360 KB) and
`CourierPrime-Regular.ttf` (71 KB) are both `<link rel="preload">`ed — ~432 KB before HTTP
compression, on the critical path of the first paint. WOFF2 typically halves a TTF and is
universally supported now. Not done here because it needs `fontTools`/`brotli` in the container,
new binary files in the tree, `apps/api/src/og/fonts.ts` still wants TTFs (resvg reads those), and
the licence files travel with the fonts. Worth measuring before doing: the cheap half is asking
whether the italic and the second family need to be preloaded at all.

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

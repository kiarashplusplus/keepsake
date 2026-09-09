// Static HTML shell for `expo export --platform web` (`web.output: "static"`).
// See https://docs.expo.dev/router/reference/static-rendering/#root-html —
// this file is NOT part of the React tree that hydrates; it wraps every
// exported route's shell once, at export time.
import { ScrollViewStyleReset } from "expo-router/html";
import * as React from "react";
import { themeCssVariables } from "@keepsake/tokens/colors";
import { viewportCssVariables } from "@keepsake/tokens/breakpoints";
import { config } from "@/lib/config";

// The pre-hydration script runs before React attaches, so the very first
// paint already has the right `data-theme`/`color-scheme` — this is what
// prevents a flash of the wrong theme on reload. It intentionally does NOT
// import `src/ui/theme.tsx` (that module isn't loaded yet); it duplicates
// just the storage key and the three valid values.
//
// Issue #44 folds a second, unrelated decision into this same script rather
// than adding a fourth inline `<script>` tag: every inline script here is a
// CSP `script-src` hash in `apps/web/public/_headers` AND
// `apps/api/src/middleware/securityHeaders.ts` (the two must stay byte-for-
// byte identical — see either file's header comment), so changing one
// script's shape is a smaller, safer diff than growing the allowlist with a
// new one. Order matters: the root-redirect block runs FIRST, before the
// theme read, so a first-time visitor never runs code that assumes it's
// looking at the feed.
//
// ROOT REDIRECT: `keepsake.ing` should show a short explainer to a
// first-time visitor and the feed to everyone else — **unless the URL carries
// a `q`**, added 2026-09-07. `location.replace("/welcome")` drops
// `location.search`, so a first-time visitor arriving at `keepsake.ing/?q=teacup`
// landed on the explainer with their search silently discarded. That is also
// exactly what a client following the `SearchAction` in the root JSON-LD below
// does, which would have made the structured data describe a search entry
// point that does not work.
//
// Specifically `q`, not "any query string". The broader test looked tidier and
// was wrong: `?fbclid=`, `?gclid=` and `?utm_source=` are exactly how a
// first-time visitor arrives from an ad or a shared link, and skipping the
// explainer for them would ALSO set `VISITED_KEY` on the way past — so they
// would never see it, then or later. Keepsake runs Google Ads; this is the
// common case, not the edge case. The other half of that, added 2026-09-08:
// the redirect carries `location.search` across to `/welcome` instead of
// dropping it. `location.replace("/welcome")` discarded the whole query
// string, so every `utm_*`, `gclid` and `fbclid` on the single most-linked
// URL this product has died at exactly the visitor it describes — a
// first-timer arriving from an ad or a shared link, which is the only
// visitor this branch ever runs for. Attribution for the campaign that paid
// for the click was therefore never observable. `q` is still the one
// parameter that skips the explainer entirely; everything else now rides
// along to it. Editing the script below changes its CSP hash —
// see the note above `PREHYDRATION_SCRIPT`'s enumeration in
// `apps/web/public/_headers` and `apps/api/src/middleware/securityHeaders.ts`,
// which must be updated together, byte for byte.
//
// The naive fix — branch
// on visitor state inside the Feed component itself, after mount — was
// rejected for two reasons: (1) despite `web.output: "static"`, `expo
// export`'s per-route HTML ships an EMPTY body (a Suspense placeholder, no
// prerendered markup — confirmed by reading `dist/index.html` after export,
// not assumed), so the app's real first paint is whatever `index.tsx` renders
// once React attaches: the Feed's own loading skeleton. A `useEffect` there
// that redirects a first-time visitor away would still show that skeleton
// for a frame first — a visible flash of "feed" content for someone who is,
// by definition, seeing this domain for the first time. (2) Branching
// server-side instead (a Worker route with `Vary`) needs a cookie, and the
// one strong signal this app has — the `ks_` owner token — deliberately
// lives in `localStorage` only, never sent to the server on a plain page
// load (see docs/design/identity.md). A new cookie mirroring it would be a
// second copy of identity state that can drift, on the one path (`/`) this
// repo has explicitly called out as needing to stay cacheable with no
// `Vary` split.
//
// The fix here keeps `/` exactly as cacheable as it is today — identical
// bytes for every visitor, no `Vary`, nothing server-side — by moving the
// branch BEFORE hydration instead of into it: this script runs synchronously
// in `<head>`, before the body is parsed, so `location.replace` fires before
// the browser ever paints the wrong content. A returning visitor (has `ks_`,
// or has been here before) is a no-op and sees the feed exactly as before,
// at zero extra cost.
//
// "Returning" = holds a `ks_` token (`OWNER_TOKEN_STORAGE_KEY` in
// `src/lib/ownerToken.ts`) OR has the `keepsake.visited.v1` flag this script
// itself sets on every page load. Not a cookie, no expiry, never leaves the
// device — the same storage tier as the theme preference below and the
// owner token itself, both already un-gated by the consent banner.
// `e2e/support/visited.ts` reads this same key back out of this file rather
// than re-declaring it, for the reason that file's own comment gives.
const PREHYDRATION_SCRIPT = `
(function () {
  try {
    var OWNER_KEY = "keepsake.ownerToken.v1";
    var VISITED_KEY = "keepsake.visited.v1";
    var returning = !!window.localStorage.getItem(OWNER_KEY) || !!window.localStorage.getItem(VISITED_KEY);
    var searching = new URLSearchParams(window.location.search).has("q");
    if (window.location.pathname === "/" && !searching && !returning) {
      window.localStorage.setItem(VISITED_KEY, "1");
      window.location.replace("/welcome" + window.location.search);
      return;
    }
    if (!returning) window.localStorage.setItem(VISITED_KEY, "1");
  } catch (e) {
    /* localStorage unavailable (privacy mode, SSR) — fall through to the
       feed rather than risk a redirect loop we can't persist past. */
  }

  try {
    var STORAGE_KEY = "keepsake.theme.v1";
    var stored = window.localStorage.getItem(STORAGE_KEY);
    var mode = stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
    var effective =
      mode === "system"
        ? (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
        : mode;
    document.documentElement.dataset.theme = effective;
    document.documentElement.style.colorScheme = effective;
  } catch (e) {
    /* localStorage unavailable (privacy mode, SSR) — default light styling in the CSS below still applies */
  }
})();
`;

/**
 * Site-level structured data, emitted on every exported page.
 *
 * Two nodes, linked by `@id` so a consumer knows the site and the
 * organisation behind it are the same subject rather than two unrelated
 * things that happen to share a name. The per-listing `Product` is injected
 * server-side instead (`apps/api/src/routes/item.ts`), because it needs the
 * row.
 *
 * ## Why this is at export time and not in the Worker
 *
 * Serving `/` through the Worker would mean adding it to production's
 * `run_worker_first`, putting a Worker hop on every root request — which
 * `wrangler.toml`'s own comment argues against, and for markup that is
 * identical for every visitor. This is a constant; it belongs in the shell.
 *
 * ## Why no `logo`
 *
 * Google's Organization logo guidance wants at least 112x112 and
 * `favicon.png` is 64x64. A `logo` Google rejects is worse than no `logo`:
 * it turns a clean parse into a validation warning. Add one when there is a
 * real square mark to point at.
 *
 * ## CSP
 *
 * `<script type="application/ld+json">` is a data block, never executed, so
 * `script-src` does not apply and this needs no fourth hash in
 * `apps/web/public/_headers` / `apps/api/src/middleware/securityHeaders.ts`.
 * That is the spec and the observed behaviour, but this repo has been bitten
 * by a silent CSP drop before (the `www.googletagmanager.com` incident both
 * of those files record), so it was checked in a browser rather than
 * assumed. If a violation ever does appear, the fix is a new hash added
 * byte-identically to both files — never to only one.
 *
 * `SearchAction` points at `/?q=`, which is the real feed parameter
 * (`src/features/feed/feedUrlParams.ts`). The pre-hydration script above had
 * to stop dropping `location.search` for that to be true; see its comment.
 */
const ROOT_JSON_LD = JSON.stringify([
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": "https://keepsake.ing/#website",
    url: "https://keepsake.ing/",
    name: "Keepsake",
    description: "Give a keepsake a second life.",
    inLanguage: "en",
    publisher: { "@id": "https://keepsake.ing/#organization" },
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: "https://keepsake.ing/?q={search_term_string}",
      },
      "query-input": "required name=search_term_string",
    },
  },
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": "https://keepsake.ing/#organization",
    name: "Keepsake",
    url: "https://keepsake.ing/",
    description: "A free gifting marketplace for objects with a story.",
  },
]);

/**
 * The cache-busting token on every `/fonts/*` URL in this file and in
 * `apps/site/public/site.css`.
 *
 * `apps/web/public/_headers` serves `/fonts/*` as
 * `max-age=31536000, immutable` under filenames that carry no content hash —
 * `Fraunces-VF.ttf` is `Fraunces-VF.ttf` forever. `immutable` is a promise
 * that the bytes at a URL will never change, and a browser that has one
 * takes it literally: it will not revalidate for a year, not even on a
 * reload. So replacing a font file in place — a new Fraunces cut, a
 * subsetted CourierPrime — would leave every returning visitor rendering the
 * old one, invisibly, for up to twelve months, while a fresh visitor got the
 * new one. The two would not be reconcilable by anything short of renaming
 * the file.
 *
 * ## Why WOFF2 with a TTF fallback
 *
 * The faces below list `.woff2` first and the `.ttf` second, and a browser
 * takes the first format it supports — so every browser since ~2016 fetches
 * the WOFF2 and the TTF is dead weight nobody downloads. It stays declared
 * for two reasons: it is the fallback for anything that predates WOFF2, and
 * it is the byte-source `apps/web/test/guards/ogCardFonts.test.ts` compares
 * the OG card's own Courier Prime against. **Order is the whole point** —
 * listing the TTF first would silently ship the big file to everyone —
 * so preflight's `fonts` check fails a `.ttf` reference that is not
 * preceded by its `.woff2`.
 *
 * Uncompressed, the two preloaded faces go 431,628 -> 221,708 bytes
 * (Fraunces-VF 360,440 -> 194,660; CourierPrime-Regular 71,188 -> 27,048).
 * The honest caveat: a TTF served with Brotli is already close to a WOFF2
 * (199,171 for Fraunces at q11, measured locally), so the win is only that
 * large if the edge was serving these uncompressed — which is not knowable
 * from a container that cannot reach the site. WOFF2 makes it moot: it is
 * pre-compressed, so it does not depend on whether Cloudflare decides
 * `font/ttf` is compressible today.
 *
 * **Not subsetted, deliberately.** Fraunces covers 624 codepoints and they
 * are all Latin (no Greek, no Cyrillic); 190 of them are Latin-1 and Latin
 * Extended-A, which is what spells Zoë, José and Łukasz. The stories on this
 * site are written by strangers about their own things, so dropping accented
 * Latin to save ~30% of the glyphs would mangle real people's words in the
 * one place this product is about.
 *
 * The `?v=` makes the URL, and therefore the cache key, a function of the
 * bytes: replace a font and the token changes, so every visitor fetches the
 * new object once and keeps caching it for a year. It is a plain literal
 * rather than something computed at export time because `site.css` is a
 * static file with no build step of its own and has to carry the same value
 * — one hand-written token in two files, with a check that recomputes it.
 *
 * That check is preflight's `fonts`: it hashes every font file on disk
 * and fails if either file's token is not the hash of what is actually on
 * disk. So the failure mode is "preflight is red until you paste the new
 * token", not "returning visitors silently keep the old font".
 */
const FONT_VERSION = "2cd9800c";

/**
 * The theme, as CSS custom properties, in the one place they can be set
 * before a single byte of JavaScript runs.
 *
 * Generated from `@keepsake/tokens/colors` — a `:root` block of the light
 * values and a `[data-theme="dark"]` block of the dark ones, for the eight
 * tokens that differ between the two. The pre-hydration script above puts
 * `data-theme` on `<html>` from localStorage before the body is parsed, so
 * the correct palette is in force at the first paint, on markup that is
 * identical either way. That is what lets `src/ui/theme.tsx` render the app
 * on the server instead of waiting for a storage read — see its header.
 *
 * `--ks-grain-*` are not colours and are not in the tokens package: they are
 * the two properties `src/ui/KraftTable.web.tsx` used to switch on `mode`,
 * which is the other thing that made the table's markup theme-dependent.
 */
const THEME_CSS = `
${themeCssVariables()}
:root { --ks-grain-blend: multiply; --ks-grain-opacity: 0.5; }
[data-theme="dark"] { --ks-grain-blend: overlay; --ks-grain-opacity: 0.55; }
`;

/**
 * The viewport switch — the same trick as THEME_CSS above, for the same
 * reason, one axis over.
 *
 * The theme is set before the first paint because the markup is identical in
 * light and dark and only the palette differs. Width was not: components
 * branched on `useWindowDimensions()`, which is 0 in a static render, so the
 * one exported HTML file every device receives carried the *phone* header,
 * hero and location controls — and a desktop visitor watched them snap to the
 * wide layout the moment React hydrated and read the real width. Measured in
 * production's own bytes, 2026-09-09.
 *
 * A media query is the only thing that knows the viewport before JavaScript
 * runs, so the decision moves here and the markup becomes identical at every
 * width — which is what keeps `/` cacheable with no `Vary`, exactly as the
 * pre-hydration script's comment above requires. `src/ui/viewport.web.ts`
 * consumes these; `packages/tokens/src/breakpoints.ts` generates them and
 * carries the full reasoning.
 *
 * A `<style>`, not a script, so this needs no CSP `script-src` hash the way
 * PREHYDRATION_SCRIPT does — `style-src` carries `'unsafe-inline'`.
 */
const VIEWPORT_CSS = viewportCssVariables();

const ROOT_CSS = `
html, body, #root { height: 100%; }
html {
  font-optical-sizing: auto;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}
body { margin: 0; background: var(--ks-bg, #E4DDD1); }

/* Focus ring: the \`focus\` token, 2px, offset 3px — the same treatment the
   marketing site uses. Inputs suppress this (their border is the ring). */
:focus-visible { outline: 2px solid #7A2515; outline-offset: 3px; }
[data-theme="dark"] :focus-visible { outline-color: #F0A38C; }

@media (prefers-reduced-motion: reduce) {
  :root { --ks-reduce: 1; }
}

/* A print dropping onto the table — src/ui/Print.web.tsx's entrance, in CSS
   so it runs at the first paint instead of waiting for hydration. It
   animates opacity and the individual "scale" property and never
   "transform", because each print's tilt is an inline transform:rotate() an
   animation on transform would replace, standing every card up straight.
   "both" holds the from-state before the animation starts and the to-state
   after it ends. Values from packages/tokens/src/motion.ts (dropMs 350, the
   1.03 -> 1 settle). */
@keyframes ks-print-drop {
  from { opacity: 0; scale: 1.03; }
  to { opacity: 1; scale: 1; }
}
[data-ks-print="drop"] {
  animation: ks-print-drop 350ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
@media (prefers-reduced-motion: reduce) {
  [data-ks-print="drop"] { animation: none; }
}

/* Skeleton.web.tsx's loading pulse: a 2-keyframe opacity pingpong, in CSS
   so it costs no JS runtime. Values from packages/tokens/src/motion.ts
   (shimmerMs 1400, halved per leg since withRepeat(..., -1, true) pingpongs
   between the from/to keyframes). */
@keyframes ks-skeleton-pulse {
  from { opacity: 0.7; }
  to { opacity: 1; }
}
[data-ks-skeleton="pulse"] {
  animation: ks-skeleton-pulse 700ms ease-in-out infinite alternate;
}
@media (prefers-reduced-motion: reduce) {
  [data-ks-skeleton="pulse"] { animation: none; opacity: 0.85; }
}

/* Stamp.web.tsx's review tilt and settle, in CSS so the loop and the
   settle transition cost no JS runtime. Values from
   packages/tokens/src/motion.ts.
   "breathing": tilt pingpongs 0deg -> reviewTiltDeg (1) over reviewTiltMs/2
   (1500) per leg — it starts at 0 and only ever animates toward the target,
   never negative.
   "settled": the original animates two independent Reanimated values —
   tilt back to 0 over quickMs (150) and a flip (scaleX 1 -> 0 -> 1, the
   second leg a "settle" spring: damping 14, stiffness 220, mass 1) — folded
   into one transform timeline. The tilt de-tilt is dropped entirely (it's
   at most 1deg over 150ms, imperceptible on a 96px stamp), so this keyframe
   stays flat at rotate(0deg). The flip's spring is approximated by a
   cubic-bezier overshoot; its duration (600ms) is "settle"'s ~2%-settling
   time, from its damping ratio (damping / (2*sqrt(stiffness*mass)) ~= 0.472)
   and natural frequency (sqrt(stiffness/mass) ~= 14.83 rad/s) via
   ts ~= 4/(zeta*omega0) ~= 570ms, rounded up. Re-derive if "settle" changes.
   Total duration is quickMs (150, the "close") + 600 = 750ms. */
[data-ks-stamp] { transform: rotate(0deg) scaleX(1); }
@keyframes ks-stamp-breathe {
  from { transform: rotate(0deg) scaleX(1); }
  to { transform: rotate(1deg) scaleX(1); }
}
[data-ks-stamp="breathing"] {
  animation: ks-stamp-breathe 1500ms ease-in-out infinite alternate;
}
@keyframes ks-stamp-settle {
  0% { transform: rotate(0deg) scaleX(1); animation-timing-function: ease-in; }
  20% { transform: rotate(0deg) scaleX(0); animation-timing-function: cubic-bezier(0.34, 1.56, 0.64, 1); }
  100% { transform: rotate(0deg) scaleX(1); }
}
[data-ks-stamp="settled"] {
  animation: ks-stamp-settle 750ms both;
}
@media (prefers-reduced-motion: reduce) {
  [data-ks-stamp] { animation: none; transform: rotate(0deg) scaleX(1); }
}

@font-face {
  font-family: "Fraunces";
  src:
    url("/fonts/Fraunces-VF.woff2?v=${FONT_VERSION}") format("woff2"),
    url("/fonts/Fraunces-VF.ttf?v=${FONT_VERSION}") format("truetype-variations");
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
  font-optical-sizing: auto;
}
@font-face {
  font-family: "Fraunces";
  src:
    url("/fonts/Fraunces-Italic-VF.woff2?v=${FONT_VERSION}") format("woff2"),
    url("/fonts/Fraunces-Italic-VF.ttf?v=${FONT_VERSION}") format("truetype-variations");
  font-weight: 100 900;
  font-style: italic;
  font-display: swap;
  font-optical-sizing: auto;
}
@font-face {
  font-family: "CourierPrime";
  src:
    url("/fonts/CourierPrime-Regular.woff2?v=${FONT_VERSION}") format("woff2"),
    url("/fonts/CourierPrime-Regular.ttf?v=${FONT_VERSION}") format("truetype");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "CourierPrime";
  src:
    url("/fonts/CourierPrime-Bold.woff2?v=${FONT_VERSION}") format("woff2"),
    url("/fonts/CourierPrime-Bold.ttf?v=${FONT_VERSION}") format("truetype");
  font-weight: 700;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "CourierPrime";
  src:
    url("/fonts/CourierPrime-Italic.woff2?v=${FONT_VERSION}") format("woff2"),
    url("/fonts/CourierPrime-Italic.ttf?v=${FONT_VERSION}") format("truetype");
  font-weight: 400;
  font-style: italic;
  font-display: swap;
}
@font-face {
  font-family: "CourierPrime";
  src:
    url("/fonts/CourierPrime-BoldItalic.woff2?v=${FONT_VERSION}") format("woff2"),
    url("/fonts/CourierPrime-BoldItalic.ttf?v=${FONT_VERSION}") format("truetype");
  font-weight: 700;
  font-style: italic;
  font-display: swap;
}
/* The app's only icon glyphs — chevron-back/-forward, close, trash-outline,
   sunny, moon, contrast, star-outline (src/ui/Icon.tsx) — subset from
   @expo/vector-icons' Ionicons.ttf (\`f229\`, \`f23b\`, \`f24a\`, \`f5f6\`,
   \`f5ad\`, \`f460\`, \`f28c\`, \`f599\`) with fonttools' pyftsubset. The full font is
   ~207KB Brotli-compressed for ~1,300 glyphs this app never renders; the
   subset is ~1.6KB for the 8 it does. No .ttf fallback: nothing here reads
   these bytes back out the way ogCardFonts.test.ts does for Fraunces/Courier
   Prime, so there's no second consumer to keep in sync.
*/
@font-face {
  font-family: "Ionicons-subset";
  src: url("/fonts/Ionicons-subset.woff2?v=${FONT_VERSION}") format("woff2");
  font-weight: normal;
  font-style: normal;
  font-display: block;
}
`;

export default function Root({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        {/* `interactive-widget=resizes-content` is load-bearing, not decoration.
            Its default is `resizes-visual`, under which the on-screen keyboard
            shrinks only the *visual* viewport and leaves the layout viewport
            alone — so `100dvh` (and `vh`, and `useWindowDimensions`) keep
            reporting the full, keyboard-covered screen, and the only number
            that moves is `visualViewport.height`. That default is precisely
            what forced the `visualViewport` corrections that
            `docs/platform-differences.md` §3 warns off, and what made them
            look necessary. Under `resizes-content` the keyboard resizes the
            layout viewport instead, so `100dvh` contracts on its own and
            `src/ui/Sheet.tsx` needs no JS position correction at all. Removing
            the correction without setting this would just restore the original
            bug (#336) — a focused field sitting under the keyboard. */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"
        />
        <meta name="color-scheme" content="light dark" />
        <meta name="theme-color" content="#E4DDD1" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#2B2119" media="(prefers-color-scheme: dark)" />

        <title>Keepsake</title>
        <meta name="description" content="Give a keepsake a second life." />

        {/* Default Open Graph / Twitter tags — what `keepsake.ing` itself
            unfurls as. The Worker replaces all of these on `/item/:id` via
            HTMLRewriter (see `apps/api/src/routes/item.ts`); everywhere else
            this is the preview.

            The origin is hardcoded rather than read from `config.siteUrl`,
            which is `""` in production by design (same-origin —
            `src/lib/config.ts`) and `http://localhost:8081` in
            `.env.example`. `apps/site/public/{about,privacy,terms}.html`
            already hardcode it, so this matches rather than inventing a
            second convention. The consequence is that unfurling a *preview*
            root shows production's card — which is the
            intended posture, not a leak: preview serves `Disallow: /` and an
            unconditional `X-Robots-Tag: noindex, nofollow`
            (`apps/api/src/routes/robots.ts`). Don't "fix" it.

            **No `og:url` and no `<link rel="canonical">` here, and that is
            still right.** Both are per-page values and this file is ONE shell
            shared by every exported route — a canonical of
            `https://keepsake.ing/` in it tells a crawler that `/welcome`,
            `/give`, `/mine` and `/about` are all duplicates of the homepage,
            which is worse than declaring nothing. (Verified in `dist/` when
            it was briefly added: 17 pages carried it.)

            They are no longer simply absent, though. `scripts/seo-html.mjs`
            writes a real per-route canonical and `og:url` into the exported
            *files* after `expo export` — which is where a per-route value
            can be true, since the files are per-route even though this
            component is not — and gives every other exported page
            `<meta name="robots" content="noindex, follow">`. `/item/:id`
            gets its canonical and `og:url` from the Worker's rewriter, and
            `apps/site`'s static pages carry their own.

            `og:image` was relative (`/og-default.png`) until 2026-09-07.
            Facebook and WhatsApp both want an absolute URL and mishandle a
            relative one, which meant the bare domain — the single most
            shared link this product has — unfurled with no image at all in
            the two places it matters most. No CSP change is involved here;
            these are `<meta>` tags, not scripts. */}
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Keepsake" />
        <meta property="og:locale" content="en_US" />
        <meta property="og:title" content="Keepsake" />
        <meta property="og:description" content="Give a keepsake a second life." />
        <meta property="og:image" content="https://keepsake.ing/og-default.png" />
        <meta property="og:image:type" content="image/png" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta
          property="og:image:alt"
          content="A taped photographic print on a kraft table, reading “Give a keepsake a second life.”"
        />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:image" content="https://keepsake.ing/og-default.png" />
        {/*
          The marker below must be a literal HTML comment `<!--KEEPSAKE_OG-->`
          in the exported markup so the Worker's HTMLRewriter can find it on
          `/item/:id` and splice in listing-specific OG/Twitter tags. A plain
          JSX comment (`{/* ... *\/}`) is stripped by Babel and never reaches
          the DOM at all; `dangerouslySetInnerHTML` on a bare `<div>` would be
          moved out of `<head>` by the HTML5 parser (div isn't allowed
          metadata content, so the parser implicitly closes `<head>` and
          starts `<body>`). `<template>` IS valid metadata content, and — unlike
          `<script>`/`<style>`/`<noscript>`, which tokenize their contents as
          raw text — its contents use ordinary HTML tokenization, so the
          `<!--KEEPSAKE_OG-->` inside genuinely tokenizes as a Comment node
          that HTMLRewriter can select.
        */}
        <template dangerouslySetInnerHTML={{ __html: "<!--KEEPSAKE_OG-->" }} />

        {/* Two icon declarations reach the browser, and that is deliberate
            rather than a leftover: this one, and a bare
            `<link rel="icon" href="/favicon.ico">` Expo injects into every
            exported page from `app.base.json`'s `web.favicon`. They are the
            same artwork — Expo generates the .ico from this very PNG — so a
            browser choosing either shows the same mark, and the .ico is what
            the crawlers and old clients that only ask for `/favicon.ico`
            find. What this one now carries is `type` and `sizes`, which the
            injected one has no way to state: without them a browser has to
            fetch an icon to learn what it is. Do not add a third.
            `apps/site`'s static pages declare none and fall back to
            `/favicon.ico`, which is in `dist/` for exactly that reason. */}
        <link rel="icon" href="/favicon.png" type="image/png" sizes="64x64" />
        <link
          rel="preload"
          href={`/fonts/Fraunces-VF.woff2?v=${FONT_VERSION}`}
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <link
          rel="preload"
          href={`/fonts/CourierPrime-Regular.woff2?v=${FONT_VERSION}`}
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />

        {/* Prevents a flash of unstyled/incorrectly-scrolling content from
            react-native-web's default ScrollView-as-body behavior. */}
        <ScrollViewStyleReset />

        <style dangerouslySetInnerHTML={{ __html: THEME_CSS }} />
        <style dangerouslySetInnerHTML={{ __html: VIEWPORT_CSS }} />
        <style dangerouslySetInnerHTML={{ __html: ROOT_CSS }} />
        <script dangerouslySetInnerHTML={{ __html: PREHYDRATION_SCRIPT }} />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: ROOT_JSON_LD }} />

        {/* Consent. `/consent.js` (source: `public/consent.js`) is the single
            shared implementation of the store, the banner and every
            third-party loader — the same file `apps/site`'s static pages load,
            so one decision covers /about, /privacy, /terms and the app. It is
            the ONLY thing that injects a third-party script, so it does not
            have to be blocking: nothing is racing it to run first.

            The id below reaches it as a meta tag because it is a static file
            and cannot read `process.env`. An absent or empty value is the kill
            switch — nothing loads, in any environment, whatever the visitor
            consented to. `apps/web/scripts/copy-site.mjs` performs the same
            substitution for the static pages.

            `ks-google-ads-id` below is deliberately empty, and that is the
            kill switch (#175, Kiarash's call: no Google Ads for now). It used
            to be `config.googleAdsId ? <meta …> : null`, and that condition
            was false in every build ever shipped, because no deploy passed
            the variable. The variable and its readers are gone; the tag stays
            declared-and-empty for the same reason the static pages keep it —
            `/consent.js` still registers an "advertising" provider and
            `test/guards/privacyPolicy.test.ts` requires every provider to be
            wired on every page, so an absent tag is drift rather than a
            decision. consent.js reads "", fails its /^(AW|G|GT)-/ test, and
            returns before touching the network. */}
        <meta name="ks-google-ads-id" content="" />
        {config.cfWebAnalyticsToken ? (
          <meta name="ks-cf-beacon-token" content={config.cfWebAnalyticsToken} />
        ) : null}
        <script src="/consent.js" defer />
      </head>
      <body>{children}</body>
    </html>
  );
}

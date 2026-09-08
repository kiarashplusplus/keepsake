// Static HTML shell for `expo export --platform web` (`web.output: "static"`).
// See https://docs.expo.dev/router/reference/static-rendering/#root-html —
// this file is NOT part of the React tree that hydrates; it wraps every
// exported route's shell once, at export time.
import { ScrollViewStyleReset } from "expo-router/html";
import * as React from "react";
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
// common case, not the edge case. Editing the script below changes its CSP hash —
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
      window.location.replace("/welcome");
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

const ROOT_CSS = `
html, body, #root { height: 100%; }
html {
  font-optical-sizing: auto;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}
body { margin: 0; background: #D2BC97; }
[data-theme="dark"] body { background: #2B2119; }

/* Focus ring: the \`focus\` token, 2px, offset 3px — the same treatment the
   marketing site uses. Inputs suppress this (their border is the ring). */
:focus-visible { outline: 2px solid #7A2515; outline-offset: 3px; }
[data-theme="dark"] :focus-visible { outline-color: #F0A38C; }

@media (prefers-reduced-motion: reduce) {
  :root { --ks-reduce: 1; }
}

@font-face {
  font-family: "Fraunces";
  src: url("/fonts/Fraunces-VF.ttf") format("truetype-variations");
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
  font-optical-sizing: auto;
}
@font-face {
  font-family: "Fraunces";
  src: url("/fonts/Fraunces-Italic-VF.ttf") format("truetype-variations");
  font-weight: 100 900;
  font-style: italic;
  font-display: swap;
  font-optical-sizing: auto;
}
@font-face {
  font-family: "CourierPrime";
  src: url("/fonts/CourierPrime-Regular.ttf") format("truetype");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "CourierPrime";
  src: url("/fonts/CourierPrime-Bold.ttf") format("truetype");
  font-weight: 700;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "CourierPrime";
  src: url("/fonts/CourierPrime-Italic.ttf") format("truetype");
  font-weight: 400;
  font-style: italic;
  font-display: swap;
}
@font-face {
  font-family: "CourierPrime";
  src: url("/fonts/CourierPrime-BoldItalic.ttf") format("truetype");
  font-weight: 700;
  font-style: italic;
  font-display: swap;
}
`;

export default function Root({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="color-scheme" content="light dark" />
        <meta name="theme-color" content="#D2BC97" media="(prefers-color-scheme: light)" />
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

            **No `og:url` and no `<link rel="canonical">` here.** Both are
            per-page values and this file is ONE shell shared by every
            exported route — a canonical of `https://keepsake.ing/` in it
            tells a crawler that `/welcome`, `/give`, `/mine` and `/about`
            are all duplicates of the homepage, which is worse than declaring
            nothing. (Verified in `dist/` when it was briefly added: 17 pages
            carried it.) `/item/:id` gets a real canonical and `og:url` from
            the Worker's rewriter, and `apps/site`'s static pages carry their
            own; the remaining routes are app screens with nothing to index.

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

        <link rel="icon" href="/favicon.png" />
        <link
          rel="preload"
          href="/fonts/Fraunces-VF.ttf"
          as="font"
          type="font/ttf"
          crossOrigin="anonymous"
        />
        <link
          rel="preload"
          href="/fonts/CourierPrime-Regular.ttf"
          as="font"
          type="font/ttf"
          crossOrigin="anonymous"
        />

        {/* Prevents a flash of unstyled/incorrectly-scrolling content from
            react-native-web's default ScrollView-as-body behavior. */}
        <ScrollViewStyleReset />

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

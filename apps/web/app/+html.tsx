// Static HTML shell for `expo export --platform web` (`web.output: "static"`).
// See https://docs.expo.dev/router/reference/static-rendering/#root-html —
// this file is NOT part of the React tree that hydrates; it wraps every
// exported route's shell once, at export time.
import { ScrollViewStyleReset } from "expo-router/html";
import * as React from "react";

// The pre-hydration script runs before React attaches, so the very first
// paint already has the right `data-theme`/`color-scheme` — this is what
// prevents a flash of the wrong theme on reload. It intentionally does NOT
// import `src/ui/theme.tsx` (that module isn't loaded yet); it duplicates
// just the storage key and the three valid values.
const THEME_PREHYDRATION_SCRIPT = `
(function () {
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

const ROOT_CSS = `
html, body, #root { height: 100%; }
html {
  font-optical-sizing: auto;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}
body { margin: 0; background: #F6EFE1; }
[data-theme="dark"] body { background: #1B1512; }

/* Focus ring: the \`focus\` token, 2px, offset 3px — the same treatment the
   marketing site uses. Inputs suppress this (their border is the ring). */
:focus-visible { outline: 2px solid #8C3A1E; outline-offset: 3px; }
[data-theme="dark"] :focus-visible { outline-color: #F3A97E; }

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
  font-family: "Inter";
  src: url("/fonts/InterVariable.ttf") format("truetype-variations");
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "Inter";
  src: url("/fonts/InterVariable-Italic.ttf") format("truetype-variations");
  font-weight: 100 900;
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
        <meta name="theme-color" content="#F6EFE1" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#1B1512" media="(prefers-color-scheme: dark)" />

        <title>Keepsake</title>
        <meta name="description" content="Give a keepsake a second life." />

        {/* Default Open Graph / Twitter tags. The Worker rewrites these on
            /item/:id via HTMLRewriter, targeting the marker comment below —
            see apps/api's route for /item/:id (owned by another agent). */}
        <meta property="og:site_name" content="Keepsake" />
        <meta property="og:title" content="Keepsake" />
        <meta property="og:description" content="Give a keepsake a second life." />
        <meta property="og:image" content="/og-default.png" />
        <meta name="twitter:card" content="summary_large_image" />
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
          href="/fonts/InterVariable.ttf"
          as="font"
          type="font/ttf"
          crossOrigin="anonymous"
        />

        {/* Prevents a flash of unstyled/incorrectly-scrolling content from
            react-native-web's default ScrollView-as-body behavior. */}
        <ScrollViewStyleReset />

        <style dangerouslySetInnerHTML={{ __html: ROOT_CSS }} />
        <script dangerouslySetInnerHTML={{ __html: THEME_PREHYDRATION_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

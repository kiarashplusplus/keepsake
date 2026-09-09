// The header theme toggle for the three static pages (about, privacy, terms
// — issue #373 finding 8). Loaded with `defer` from an external file rather
// than another inline `<script>` so it needs no CSP `sha256-` hash of its
// own: `script-src 'self'` (apps/web/public/_headers,
// apps/api/src/middleware/securityHeaders.ts) already allows same-origin
// script files, and the inline no-flash script in <head> — the one that
// DOES need a hash, and must stay byte-identical across all three pages —
// is untouched by this file.
//
// Reads and writes the exact key the app's ThemeProvider does
// (THEME_MODE_STORAGE_KEY in apps/web/src/ui/theme.tsx) and cycles modes in
// the same order as AppHeader.tsx's NEXT_MODE, so a visitor's choice here is
// the same choice everywhere else in the product and vice versa.
//
// Progressive enhancement, not a requirement: the button starts `hidden` in
// markup, and this script's only job before wiring the click handler is to
// reveal it. Every other header control (Browse/Mine/About, Give) is a plain
// `<a>` and already works with no JS at all; this is the one piece of the
// finding that cannot be, so it opts out of existing instead of sitting on
// the page inert.
(function () {
  "use strict";

  var STORAGE_KEY = "keepsake.theme.v1";
  var NEXT_MODE = { light: "dark", dark: "system", system: "light" };
  var MODE_LABEL = { light: "Light", dark: "Dark", system: "System" };

  function readStoredMode() {
    try {
      var stored = window.localStorage.getItem(STORAGE_KEY);
      return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
    } catch (e) {
      // Privacy mode / storage disabled: behave as "system" and let every
      // click still work for the rest of the visit, same as consent.js's
      // read failures do.
      return "system";
    }
  }

  function writeStoredMode(mode) {
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch (e) {
      /* nothing to persist to; the click still repaints this page */
    }
  }

  function resolveEffective(mode) {
    if (mode !== "system") return mode;
    var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    return prefersDark ? "dark" : "light";
  }

  // Same two lines the pre-hydration script in <head> and
  // apps/web/src/ui/theme.tsx's `applyDomTheme` both do: the attribute
  // site.css keys its dark-mode rules on, and the UA-chrome hint.
  function paintDocument(effective) {
    document.documentElement.dataset.theme = effective;
    document.documentElement.style.colorScheme = effective;
  }

  function paintButton(button, mode) {
    button.setAttribute("data-mode", mode);
    button.setAttribute("aria-label", "Theme: " + MODE_LABEL[mode] + ". Tap to change.");
  }

  function init() {
    var button = document.querySelector("[data-theme-toggle]");
    if (!button) return;

    var mode = readStoredMode();
    paintButton(button, mode);
    button.hidden = false;

    button.addEventListener("click", function () {
      mode = NEXT_MODE[mode];
      writeStoredMode(mode);
      paintDocument(resolveEffective(mode));
      paintButton(button, mode);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

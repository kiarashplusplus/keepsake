/**
 * Guard: the header on `apps/site/public/{about,privacy,terms}.html` stays at
 * parity with the app's own (`apps/web/src/ui/AppHeader.tsx`) — issue #373
 * finding 8, read off `docs/qa/baseline/ux-desktop/terms.jpg` next to
 * `feed.jpg`: the static pages had no `Mine` link (so a giver following the
 * footer to Privacy or Terms had no way back to their own listings), Give was
 * a plain nav link rather than the filled button the app gives it, and there
 * was no theme toggle even though the pages already honour the stored theme.
 *
 * These pages are hand-written HTML with no build step, so nothing keeps
 * `about.html` and its two siblings in step with each other by construction
 * the way a shared component would — `rootOpenGraph.test.ts`'s "the same
 * WebSite and Organization the static pages carry" test exists for exactly
 * this reason, one field over. This is that same guard for the header.
 */
import fs from "node:fs";
import path from "node:path";

const SITE_PUBLIC = path.resolve(__dirname, "../../../site/public");
const THEME_TSX = fs.readFileSync(path.resolve(__dirname, "../../src/ui/theme.tsx"), "utf8");

const PAGES = ["about.html", "privacy.html", "terms.html"] as const;
const SOURCES = Object.fromEntries(PAGES.map((f) => [f, fs.readFileSync(path.join(SITE_PUBLIC, f), "utf8")])) as Record<
  (typeof PAGES)[number],
  string
>;

/** The `<header class="site-header">…</header>` block, with the one
 * per-page difference — which link (if any) carries `aria-current="page"` —
 * normalised away, so the comparison is about structure, not about which
 * page is "on". */
function headerBlock(html: string): string {
  const match = /<header class="site-header">[\s\S]*?<\/header>/.exec(html);
  if (!match) throw new Error("no <header class=\"site-header\"> found");
  return match[0].replace(/\s*aria-current="page"/g, "");
}

/** `THEME_MODE_STORAGE_KEY` from `theme.tsx`'s source, not retyped here —
 * a copy of the literal would pass even if the real key changed under it. */
function themeStorageKey(): string {
  const match = /const THEME_MODE_STORAGE_KEY = "([^"]+)"/.exec(THEME_TSX);
  if (!match) throw new Error("theme.tsx no longer declares THEME_MODE_STORAGE_KEY — update the regex above");
  return match[1] as string;
}

describe("apps/site/public/*.html header parity with AppHeader.tsx (issue #373)", () => {
  it("all three pages carry byte-identical headers, aria-current aside", () => {
    const [first, ...rest] = PAGES;
    const base = headerBlock(SOURCES[first]);
    for (const page of rest) {
      expect({ page, header: headerBlock(SOURCES[page]) }).toEqual({ page, header: base });
    }
  });

  it("links to /mine, the same route AppHeader.tsx's Mine nav item targets", () => {
    const appHeader = fs.readFileSync(path.resolve(__dirname, "../../src/ui/AppHeader.tsx"), "utf8");
    expect(appHeader).toContain('href="/mine" label="Mine"');
    for (const page of PAGES) {
      const header = headerBlock(SOURCES[page]);
      expect(header).toMatch(/<a href="\/mine">Mine<\/a>/);
    }
  });

  it("gives Give the app's filled-button treatment, not a plain nav link", () => {
    for (const page of PAGES) {
      const header = headerBlock(SOURCES[page]);
      // Not inside <nav class="site-nav">, which is the plain-link list —
      // Give sits alongside it as its own element, same as AppHeader.tsx's
      // Button is a sibling of its NavLinks rather than one of them.
      const nav = /<nav class="site-nav"[^>]*>[\s\S]*?<\/nav>/.exec(header)?.[0] ?? "";
      expect(nav).not.toContain("/give");
      expect(header).toMatch(/<a class="btn btn-primary" href="\/give">/);
      expect(header).toContain("Give something");
    }
  });

  it("carries a theme toggle wired to the same storage key ThemeProvider persists to", () => {
    const key = themeStorageKey();
    // `theme-toggle.js` is one shared file for all three pages, so the key
    // only needs to be right there, not retyped per page — but every page
    // must actually load it.
    const toggleJs = fs.readFileSync(path.join(SITE_PUBLIC, "theme-toggle.js"), "utf8");
    expect(toggleJs).toContain(`"${key}"`);
    for (const page of PAGES) {
      expect(SOURCES[page]).toContain('<script src="/theme-toggle.js" defer></script>');
      const header = headerBlock(SOURCES[page]);
      expect(header).toMatch(/<button[^>]*data-theme-toggle[^>]*>/);
    }
  });

  it("cycles light -> dark -> system, the same order AppHeader.tsx's NEXT_MODE uses", () => {
    const appHeader = fs.readFileSync(path.resolve(__dirname, "../../src/ui/AppHeader.tsx"), "utf8");
    const toggleJs = fs.readFileSync(path.join(SITE_PUBLIC, "theme-toggle.js"), "utf8");
    // Read structurally rather than string-diffing the two object literals
    // (one is TS, one is JS) — same three keys mapping to the same three
    // values, in the same order, rather than eyeballing two files that
    // happen to look alike today.
    const pairs = (src: string) => [...src.matchAll(/(light|dark|system):\s*"(light|dark|system)"/g)].map((m) => [m[1], m[2]]);
    const appPairs = pairs(appHeader);
    expect(appPairs).toEqual([
      ["light", "dark"],
      ["dark", "system"],
      ["system", "light"],
    ]);
    expect(pairs(toggleJs)).toEqual(appPairs);
  });
});

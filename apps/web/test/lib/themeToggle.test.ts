/**
 * These tests run the REAL `apps/site/public/theme-toggle.js` in jsdom — the
 * same bytes the browser is served — the same approach `consent.test.ts`
 * takes with `consent.js` and for the same reason: a TypeScript restatement
 * of the toggle's logic could drift from the shipped file silently, and a
 * test against a stand-in would be a second implementation to keep in step,
 * not a proof of the first.
 *
 * Issue #373 finding 8: the static pages had no way to switch theme, even
 * though they already honoured a theme stored by the app. This is the proof
 * that the control this PR adds actually reads and writes the same
 * `keepsake.theme.v1` key `apps/web/src/ui/theme.tsx`'s `ThemeProvider` does,
 * resolves "system" the same way, and repaints `<html data-theme>` the same
 * way — so a choice made here is a choice made everywhere in the product.
 */
import fs from "node:fs";
import path from "node:path";

const THEME_TOGGLE_JS = fs.readFileSync(path.resolve(__dirname, "../../../site/public/theme-toggle.js"), "utf8");
const STORAGE_KEY = "keepsake.theme.v1";

/** Matches `matchMedia`'s shape closely enough for `resolveEffective` — a
 * `MediaQueryList`-like object whose `.matches` this test controls. */
function stubPrefersDark(matches: boolean): void {
  window.matchMedia = jest.fn().mockImplementation((query: string) => ({
    matches: query === "(prefers-color-scheme: dark)" ? matches : false,
    media: query,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  })) as unknown as typeof window.matchMedia;
}

/** Evaluate `/theme-toggle.js` against the current DOM, i.e. simulate a page
 * load with the button already in the markup (as it is in `about.html` et
 * al.) and `document.readyState` already "complete" — the same state the
 * browser is in by the time a `defer`red script runs. */
function loadPage(): HTMLButtonElement {
  document.body.innerHTML = `
    <button type="button" class="theme-toggle" data-theme-toggle hidden aria-label="placeholder">
      <svg class="theme-icon theme-icon-light"></svg>
      <svg class="theme-icon theme-icon-dark"></svg>
      <svg class="theme-icon theme-icon-system"></svg>
    </button>
  `;
  delete (document.documentElement.dataset as { theme?: string }).theme;
  new Function(THEME_TOGGLE_JS)();
  return document.querySelector("[data-theme-toggle]") as HTMLButtonElement;
}

beforeEach(() => {
  window.localStorage.clear();
  stubPrefersDark(false);
});

describe("theme-toggle.js", () => {
  it("reveals the button and defaults to system when nothing is stored", () => {
    const button = loadPage();
    expect(button.hidden).toBe(false);
    expect(button.getAttribute("data-mode")).toBe("system");
    expect(button.getAttribute("aria-label")).toBe("Theme: System. Tap to change.");
  });

  it("starts from whatever ThemeProvider already persisted, not always system", () => {
    window.localStorage.setItem(STORAGE_KEY, "dark");
    const button = loadPage();
    expect(button.getAttribute("data-mode")).toBe("dark");
  });

  it("cycles light -> dark -> system -> light on click, writing the app's own storage key each time", () => {
    window.localStorage.setItem(STORAGE_KEY, "light");
    const button = loadPage();

    button.click();
    expect(button.getAttribute("data-mode")).toBe("dark");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("dark");

    button.click();
    expect(button.getAttribute("data-mode")).toBe("system");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("system");

    button.click();
    expect(button.getAttribute("data-mode")).toBe("light");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("light");
  });

  it("repaints <html data-theme> and color-scheme on an explicit choice", () => {
    const button = loadPage(); // starts "system"
    stubPrefersDark(false);
    button.click(); // system -> light
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("resolves 'system' against prefers-color-scheme at the moment of the click", () => {
    window.localStorage.setItem(STORAGE_KEY, "light");
    const button = loadPage();

    stubPrefersDark(true);
    button.click(); // light -> dark (explicit) — effective is "dark" regardless of the media query
    expect(document.documentElement.dataset.theme).toBe("dark");

    button.click(); // dark -> system, OS prefers dark
    expect(document.documentElement.dataset.theme).toBe("dark");

    stubPrefersDark(false);
    button.click(); // system -> light (explicit) — leaves system mode
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("survives localStorage throwing (privacy mode) instead of leaving the toggle inert", () => {
    const getItem = jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      const button = loadPage();
      expect(button.hidden).toBe(false);
      expect(button.getAttribute("data-mode")).toBe("system");
      expect(() => button.click()).not.toThrow();
      expect(button.getAttribute("data-mode")).toBe("light");
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it("does nothing, quietly, on a page with no [data-theme-toggle] button", () => {
    document.body.innerHTML = "";
    expect(() => new Function(THEME_TOGGLE_JS)()).not.toThrow();
  });
});

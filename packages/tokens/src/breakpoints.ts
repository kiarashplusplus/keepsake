/**
 * Layout breakpoints — and the CSS that puts them somewhere the browser can
 * act on them before a single byte of JavaScript runs.
 *
 * ## Why these are CSS variables and not just numbers
 *
 * `expo export --platform web` renders every route to HTML once, at build
 * time, with no viewport, and that one file is served byte-for-byte to every
 * visitor — `/` is deliberately cacheable with no `Vary` (see
 * `apps/web/app/+html.tsx`). So a component that branches on
 * `useWindowDimensions()` bakes whatever width the *build* assumed into the
 * markup that every device then gets. react-native-web's `Dimensions` reads
 * `document.documentElement.clientWidth`, which is 0 in a static render, so
 * that baked width is always the narrow one.
 *
 * That is what production shipped: `/` served the phone header, the phone
 * hero and the collapsed location controls to a 1440px desktop, and snapped
 * to the desktop layout a moment later when React hydrated and read the real
 * width. Measured in production's own bytes on 2026-09-09 — `min-height:64px`
 * on the header row, a 23px wordmark, no `Browse`/`About` links, no hero
 * deck, and the collapsed `Near · … Change` summary, all in the HTML for
 * every viewport.
 *
 * The fix is the one this codebase already uses for the theme: decide before
 * the first paint, in CSS, on markup that is identical either way. A media
 * query is the only thing that knows the viewport before JavaScript runs.
 *
 * `--ks-wide` is `0`/`1` rather than a keyword so a component can interpolate
 * it: `calc(64px + var(--ks-wide) * 12px)` is a length that steps at the
 * breakpoint, which is exactly what `useViewport().step()` builds — no
 * per-property variable has to be declared here for each new call site.
 *
 * The `*-only` variables are `display` keywords, for the cases where one
 * width renders something the other does not. Both branches ship in the HTML
 * and CSS hides one, so neither is a hydration-time swap. An element hidden
 * this way generates no box at all: it contributes nothing to a flex `gap`,
 * and it is out of both the tab order and the accessibility tree.
 *
 * `--ks-hero-fvs` is the one exception to "no per-property variable". The
 * feed hero steps between `displayLg` and `displayXl`, whose sizes `step()`
 * handles but whose `font-variation-settings` differ too — and that is a
 * string, not a length, so no `calc()` can interpolate it. Its two values are
 * read from the type scale rather than written out, so they cannot drift from
 * the tokens the narrow and wide headings actually use.
 *
 * These are `<style>` rules, not a script, so — unlike the pre-hydration
 * script above them in `+html.tsx` — they need no CSP `script-src` hash.
 * `style-src` carries `'unsafe-inline'`.
 */
import { type as typeScale } from "./typography";

export const breakpoint = {
  /**
   * Phone vs. desktop, the app-wide line. Below it the header drops its
   * secondary nav, the feed hero drops its deck and CTA, and the location
   * controls collapse behind a summary row (issue #219).
   */
  narrow: 640,
  /**
   * The category row's own line, which is deliberately not `narrow`. Issue
   * #136 took the list from five categories to eleven, and thirteen wrapped
   * chips stacked four rows deep on a phone, above the location controls and
   * before a visitor had seen a single keepsake. Below this width the row
   * scrolls sideways instead of wrapping; above it there is room for one or
   * two lines and a horizontal scroller would be the worse of the two.
   */
  categoryChips: 700,
} as const;

export type Breakpoint = keyof typeof breakpoint;

/**
 * The `:root` block `apps/web/app/+html.tsx` emits into the static shell,
 * alongside `themeCssVariables()`. Every value is declared unconditionally
 * first so a `var()` reference can never fall back to an invalid `calc()`.
 */
export function viewportCssVariables(): string {
  return [
    ":root {",
    "  --ks-wide: 0;",
    "  --ks-narrow-only: flex;",
    "  --ks-wide-only: none;",
    "  --ks-chips-wrap: nowrap;",
    "  --ks-chips-fade: flex;",
    "  --ks-chips-shrink: 0;",
    `  --ks-hero-fvs: ${typeScale.displayLg.fontVariationSettings};`,
    "}",
    `@media (min-width: ${breakpoint.narrow}px) {`,
    "  :root { --ks-wide: 1; --ks-narrow-only: none; --ks-wide-only: flex; }",
    `  :root { --ks-hero-fvs: ${typeScale.displayXl.fontVariationSettings}; }`,
    "}",
    `@media (min-width: ${breakpoint.categoryChips}px) {`,
    "  :root { --ks-chips-wrap: wrap; --ks-chips-fade: none; --ks-chips-shrink: 1; }",
    "}",
  ].join("\n");
}

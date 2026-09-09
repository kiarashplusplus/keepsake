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
 * `--ks-tile-basis` is the second, for the same reason in the other
 * direction: the admin stats strip's stamped tiles are a third of the row
 * each below the breakpoint (#363 — sized by their labels, eleven of them
 * fell into rows of 3, 2, 3, 2 and 1 at 390px) and their intrinsic width
 * above it, and `auto` is a keyword no `calc()` can step to. The third is
 * net of the two `space.md` gaps between three tiles.
 *
 * These are `<style>` rules, not a script, so — unlike the pre-hydration
 * script above them in `+html.tsx` — they need no CSP `script-src` hash.
 * `style-src` carries `'unsafe-inline'`.
 */
import { space } from "./spacing";
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
  /**
   * Where a keepsake's detail pages stop being one column and become
   * print-left / story-right — `apps/web/app/item/[id].tsx` (#222) and
   * `apps/web/app/mine/[id].tsx` (#373 finding 7), the giver's own copy of
   * the same page. It used to be a local constant on each file, defined
   * twice with a comment asking whoever changed one to change the other —
   * exactly the coupling a shared token exists to remove.
   *
   * At 1280×800 the stacked layout on either page spent the entire viewport
   * height on the photograph: the title was cut by the fold and everything
   * else was well below it, so on a page whose whole proposition is *a
   * photograph and the story attached to it* you could not see both at
   * once.
   *
   * Deliberately not `narrow` or `categoryChips`. At 820 (`item/[id].tsx`'s
   * own title breakpoint) the `grid` measure is the viewport itself, so
   * after the page's 16px gutters and the 32px column gap each column would
   * land around 378px — the phone column, twice — which is a worse page
   * than the single column it replaced, not a better one. 1024 is the first
   * width where the split is worth taking: on `item/[id].tsx`'s 5:6 print/
   * story split the print column clears ~436px and the story ~524px, a
   * print big enough to actually read the photograph off and a measure long
   * enough that the story doesn't go ragged. It is also the conventional
   * landscape-tablet / small-laptop width, so the change lands on the class
   * of screen the issue is about, and the 1280×800 frame both issues open
   * with sits well clear of it.
   *
   * Below this both pages are byte-for-byte the single-column layout they
   * always were. Most visits are narrow and #222 says that layout is fine;
   * the split is additive.
   *
   * Read with `useWindowDimensions()`, not baked into the CSS shell above:
   * unlike `narrow`/`categoryChips`, nothing on either detail page needs to
   * be correct in the zero-JS static render — there is no above-the-fold
   * decision here that a crawler or a slow connection would see wrong, only
   * a hydration-time layout change on a page that is already showing a
   * skeleton while its one API call is in flight.
   */
  detailTwoColumn: 1024,
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
    `  --ks-tile-basis: calc((100% - ${2 * space.md}px) / 3);`,
    "}",
    `@media (min-width: ${breakpoint.narrow}px) {`,
    "  :root { --ks-wide: 1; --ks-narrow-only: none; --ks-wide-only: flex; }",
    `  :root { --ks-hero-fvs: ${typeScale.displayXl.fontVariationSettings}; }`,
    "  :root { --ks-tile-basis: auto; }",
    "}",
    `@media (min-width: ${breakpoint.categoryChips}px) {`,
    "  :root { --ks-chips-wrap: wrap; --ks-chips-fade: none; --ks-chips-shrink: 1; }",
    "}",
  ].join("\n");
}

import { describe, expect, it } from "vitest";
import { breakpoint, viewportCssVariables } from "../src/breakpoints";
import { space } from "../src/spacing";
import { type } from "../src/typography";

const css = viewportCssVariables();

/** Every variable `apps/web/src/ui/viewport.web.ts` reads, and the fallback it
 * reads it with. If a name here and a name there ever stop agreeing, nothing
 * throws: the `var()` silently resolves to its fallback, one width quietly
 * renders the other's layout, and the only witness is someone looking at the
 * site on the device that lost. */
const CONSUMED = [
  ["--ks-wide", "0"],
  ["--ks-narrow-only", "flex"],
  ["--ks-wide-only", "none"],
  ["--ks-chips-wrap", "nowrap"],
  ["--ks-chips-fade", "flex"],
  ["--ks-chips-shrink", "0"],
  ["--ks-hero-fvs", type.displayLg.fontVariationSettings],
  ["--ks-tile-basis", `calc((100% - ${2 * space.md}px) / 3)`],
] as const;

describe("the viewport stylesheet", () => {
  it("declares every variable unconditionally before any media query", () => {
    const firstQuery = css.indexOf("@media");
    expect(firstQuery).toBeGreaterThan(0);
    const base = css.slice(0, firstQuery);

    for (const [name, value] of CONSUMED) {
      // In the `:root` block, not merely somewhere in the file: a variable
      // that only exists inside a media query is undefined below it, and
      // `calc()` with an undefined operand is an invalid declaration the
      // browser drops silently.
      expect(base, name).toContain(`${name}: ${value};`);
    }
  });

  it("steps every variable at the breakpoint its consumer expects", () => {
    expect(css).toContain(`@media (min-width: ${breakpoint.narrow}px)`);
    expect(css).toContain(`@media (min-width: ${breakpoint.categoryChips}px)`);

    // The narrow query flips the three that make a phone layout a desktop
    // one, and the chips query flips only its own two — they are deliberately
    // different widths, so a merge of the two blocks would move the category
    // row's behaviour to 640px without anything failing.
    const narrowBlock = css.slice(css.indexOf(`@media (min-width: ${breakpoint.narrow}px)`), css.indexOf(`@media (min-width: ${breakpoint.categoryChips}px)`));
    expect(narrowBlock).toContain("--ks-wide: 1;");
    expect(narrowBlock).toContain("--ks-narrow-only: none;");
    expect(narrowBlock).toContain("--ks-wide-only: flex;");
    // The admin stats tiles give up their third-of-the-row basis here and
    // go back to their intrinsic widths (#363) — `auto`, which is the one
    // value `step()` could never have produced.
    expect(narrowBlock).toContain("--ks-tile-basis: auto;");
    expect(narrowBlock).not.toContain("--ks-chips-wrap");

    const chipsBlock = css.slice(css.indexOf(`@media (min-width: ${breakpoint.categoryChips}px)`));
    expect(chipsBlock).toContain("--ks-chips-wrap: wrap;");
    expect(chipsBlock).toContain("--ks-chips-fade: none;");
    expect(chipsBlock).toContain("--ks-chips-shrink: 1;");
  });

  // `detailTwoColumn` never reaches `viewportCssVariables()` — it is read
  // with `useWindowDimensions()` on the two detail pages that use it, not
  // baked into the pre-hydration CSS the way `narrow`/`categoryChips` are —
  // so it gets its own direct assertion rather than a place in `CONSUMED`
  // above, which is scoped to that stylesheet.
  it("keeps detailTwoColumn at 1024, the value item/[id].tsx and mine/[id].tsx both import", () => {
    expect(breakpoint.detailTwoColumn).toBe(1024);
  });

  it("takes the hero's two variation settings from the type scale, not from a copy of it", () => {
    // `step()` interpolates lengths and cannot interpolate this one — it is a
    // string. Reading both ends from `type` is what stops the heading's axes
    // drifting from the `displayLg`/`displayXl` tokens it steps between.
    expect(css).toContain(`--ks-hero-fvs: ${type.displayLg.fontVariationSettings};`);
    expect(css).toContain(`--ks-hero-fvs: ${type.displayXl.fontVariationSettings};`);
    expect(type.displayLg.fontVariationSettings).not.toBe(type.displayXl.fontVariationSettings);
  });
});

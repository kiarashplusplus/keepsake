/**
 * The shape both halves of the viewport switch return, in a platform-neutral
 * file so neither has to import the other for it — the same arrangement
 * `dateFieldTypes.ts` has for `DateField.tsx`/`DateField.web.tsx`.
 *
 * `packages/tokens/src/breakpoints.ts` explains what the switch is for.
 */
import type { ViewStyle } from "react-native";

export type Viewport = {
  /** Renders only below `breakpoint.narrow`; hidden at or above it. */
  narrowOnly: ViewStyle;
  /** Renders only at or above `breakpoint.narrow`; hidden below it. */
  wideOnly: ViewStyle;
  /**
   * A length that is `narrow` below the breakpoint and `wide` at or above it.
   * Typed as `number` so it drops into the style props that take one
   * (`minHeight`, `gap`, `fontSize`, `paddingTop`); on the web it is really a
   * `calc()` string, which is why the value must not be read back or
   * arithmetic'd in JS.
   */
  step: (narrow: number, wide: number) => number;
  /**
   * The category row's own breakpoint (`breakpoint.categoryChips`), which is
   * not the narrow/wide one — hence its own two fields rather than a reuse of
   * the pair above. `chipsWrap` makes the row wrap instead of scroll;
   * `chipsFade` hides the trailing-edge fade, which only means anything while
   * the row still scrolls.
   */
  chipsWrap: ViewStyle["flexWrap"];
  /** Steps with `chipsWrap`: `0` while the row scrolls, `1` once it wraps —
   * see `CategoryChips.tsx` for why a wrapping content container needs it. */
  chipsShrink: ViewStyle["flexShrink"];
  chipsFade: ViewStyle;
};

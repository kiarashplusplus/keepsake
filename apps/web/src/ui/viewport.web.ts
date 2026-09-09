/**
 * The web half of the viewport switch. See
 * `packages/tokens/src/breakpoints.ts` for why this exists at all: the static
 * export renders once, with no viewport, and serves those bytes to every
 * device, so any layout decision made from `useWindowDimensions()` is baked
 * at the wrong width for somebody and snaps when React hydrates.
 *
 * So on the web nothing here reads the width. Every value is a `var()` or a
 * `calc()` the browser resolves from the media queries in the shell — which
 * means the markup this produces is identical at every viewport, the first
 * paint is already correct, and hydration changes nothing. It also means the
 * components using it stop re-rendering on every resize event.
 *
 * The native sibling (`viewport.ts`) does read the width, because there is no
 * CSS there to read it instead.
 *
 * The `as unknown as` casts are the same escape hatch the rest of this
 * codebase uses for CSS values react-native's types do not model —
 * `storyFluidFontSize`'s `clamp()` in `packages/tokens/src/typography.ts`,
 * `backgroundImage` in `KraftTable.web.tsx`, `boxShadow` in `Print.web.tsx`.
 * react-native-web passes a string style value straight through to the DOM.
 */
import type { ViewStyle } from "react-native";
import type { Viewport } from "@/ui/viewportTypes";

export type { Viewport } from "@/ui/viewportTypes";

const WEB_VIEWPORT: Viewport = {
  narrowOnly: { display: "var(--ks-narrow-only, flex)" } as unknown as ViewStyle,
  wideOnly: { display: "var(--ks-wide-only, none)" } as unknown as ViewStyle,
  step: (narrow, wide) =>
    narrow === wide ? narrow : (`calc(${narrow}px + var(--ks-wide, 0) * ${wide - narrow}px)` as unknown as number),
  chipsWrap: "var(--ks-chips-wrap, nowrap)" as unknown as ViewStyle["flexWrap"],
  chipsFade: { display: "var(--ks-chips-fade, flex)" } as unknown as ViewStyle,
};

/** Constant on the web — it closes over no state, so it is the same object on
 * every render and never causes one. */
export function useViewport(): Viewport {
  return WEB_VIEWPORT;
}

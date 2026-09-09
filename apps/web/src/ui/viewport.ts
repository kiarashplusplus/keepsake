/**
 * The native half of the viewport switch — see `viewport.web.ts` for the one
 * that matters in this product, and `packages/tokens/src/breakpoints.ts` for
 * why the split exists.
 *
 * There is no stylesheet here to resolve a media query, so this is the
 * ordinary `useWindowDimensions()` branch the web used to do: correct on
 * native, where there is no static render to disagree with, and where a
 * re-render on rotation is exactly what you want.
 */
import { useWindowDimensions, type ViewStyle } from "react-native";
import { breakpoint } from "@keepsake/tokens/breakpoints";
import type { Viewport } from "@/ui/viewportTypes";

export type { Viewport } from "@/ui/viewportTypes";

const HIDDEN: ViewStyle = { display: "none" };
const SHOWN: ViewStyle = {};

export function useViewport(): Viewport {
  const { width } = useWindowDimensions();
  const narrow = width < breakpoint.narrow;
  const chipsScroll = width < breakpoint.categoryChips;

  return {
    narrowOnly: narrow ? SHOWN : HIDDEN,
    wideOnly: narrow ? HIDDEN : SHOWN,
    step: (narrowValue, wideValue) => (narrow ? narrowValue : wideValue),
    chipsWrap: chipsScroll ? "nowrap" : "wrap",
    chipsShrink: chipsScroll ? 0 : 1,
    chipsFade: chipsScroll ? SHOWN : HIDDEN,
  };
}

import * as React from "react";

/**
 * The height actually visible to the user, in pixels — `fallbackHeight`
 * (typically `useWindowDimensions().height`) everywhere the on-screen
 * keyboard isn't covering part of the screen, and the shrunk
 * `window.visualViewport.height` while it is.
 *
 * `useWindowDimensions` tracks `window.innerWidth`/`innerHeight`: the
 * *layout* viewport, which iOS Safari leaves at the full screen height on
 * purpose when the keyboard opens (only the *visual* viewport — what's
 * actually on screen above the keyboard — shrinks), and which
 * react-native-web's own `Dimensions` 'change' event doesn't even fire for on
 * iOS Safari to begin with (necolas/react-native-web#2430). A `Sheet` sized
 * off it stays sized for the full, keyboard-covered screen, so a field near
 * the bottom of a long form ends up positioned behind the keyboard instead
 * of above it — `visualViewport.height` is the one number that reflects
 * what's actually visible.
 *
 * This only ever feeds a *size* (a `height`/`maxHeight`), never a position
 * correction computed from `visualViewport.offsetTop`/`window.scrollY` — the
 * `position: fixed` + offset-delta pattern `docs/platform-differences.md`
 * §3 calls out as "self-certifying-wrong" (the same broken measurement
 * produces both the error and the fix). Sizing a box to the visible height
 * has no such loop: it's just how tall the box may be, not where the page
 * thinks it sits.
 */
export function useVisualViewportHeight(fallbackHeight: number): number {
  // `null` until a `visualViewport` measurement lands, so the fallback below
  // covers every case with nothing to subscribe to: SSR (`expo export`
  // prerenders these routes in Node, where there's no `window` — reading
  // `visualViewport` during render would also risk a hydration mismatch on
  // the first client render), and browsers without `visualViewport` at all.
  const [visualHeight, setVisualHeight] = React.useState<number | null>(null);

  React.useEffect(() => {
    const viewport = typeof window !== "undefined" ? window.visualViewport : null;
    if (!viewport) return undefined;

    const sync = (): void => setVisualHeight(viewport.height);
    sync();
    viewport.addEventListener("resize", sync);
    return () => viewport.removeEventListener("resize", sync);
  }, []);

  return visualHeight ?? fallbackHeight;
}

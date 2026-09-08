import * as React from "react";

export type VisualViewportMetrics = {
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
   * react-native-web's own `Dimensions` 'change' event doesn't even fire for
   * on iOS Safari to begin with (necolas/react-native-web#2430).
   */
  height: number;
  /**
   * How far the visual viewport's top edge currently sits below the layout
   * viewport's origin, in layout-viewport pixels — 0 whenever they're
   * aligned (no keyboard, nothing scrolled).
   *
   * Needed alongside `height`, not just it: a `position: fixed` box is
   * pinned to the *layout* viewport's origin, which iOS Safari does not move
   * when it scrolls the page to keep a focused input above the keyboard —
   * only the visual viewport pans. Sizing such a box to `height` alone gets
   * its height right but leaves its top edge sitting wherever the layout
   * viewport's y=0 is, which drifts further from what's actually on screen
   * with every further pan (typing into a multi-line field that keeps
   * pushing the caret down is exactly what keeps re-triggering that pan) —
   * the box built entirely correctly for a screen that has since scrolled
   * out from under it, which is what reads as the sheet sliding away rather
   * than merely mis-sized.
   *
   * This is a direct, absolute reading of `visualViewport.offsetTop`, not a
   * derived correction — it never touches `window.innerHeight` or
   * `window.scrollY`, so it isn't the "self-certifying-wrong" formula
   * `docs/platform-differences.md` §3 warns off (a delta computed from
   * measurements that are themselves already wrong in the same way the
   * keyboard made them wrong). It's the one number the platform hands us
   * that already says where the visible window currently is.
   */
  offsetTop: number;
};

/**
 * See `VisualViewportMetrics` for what each field means and why both are
 * needed. `null` until a `visualViewport` measurement lands, so the fallback
 * below covers every case with nothing to subscribe to: SSR (`expo export`
 * prerenders these routes in Node, where there's no `window` — reading
 * `visualViewport` during render would also risk a hydration mismatch on the
 * first client render), and browsers without `visualViewport` at all.
 */
export function useVisualViewport(fallbackHeight: number): VisualViewportMetrics {
  const [metrics, setMetrics] = React.useState<{ height: number; offsetTop: number } | null>(null);

  React.useEffect(() => {
    const viewport = typeof window !== "undefined" ? window.visualViewport : null;
    if (!viewport) return undefined;

    const sync = (): void => setMetrics({ height: viewport.height, offsetTop: viewport.offsetTop });
    sync();
    // `resize` fires when the keyboard opens/closes (height changes);
    // `scroll` fires when iOS pans the visual viewport without resizing it —
    // e.g. nudging a caret back above the keyboard as a multi-line field
    // grows. Missing either leaves one of the two numbers stale.
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
    };
  }, []);

  return { height: metrics?.height ?? fallbackHeight, offsetTop: metrics?.offsetTop ?? 0 };
}

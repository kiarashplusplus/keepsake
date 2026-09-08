import * as React from "react";

/**
 * Pixels the consent bar currently covers at the bottom of the viewport, or 0
 * when it is hidden or was never shown.
 *
 * `public/consent.js` renders that bar into `document.body` as
 * `position: fixed; bottom: 0`, entirely outside the React tree, so nothing
 * here can measure it and nothing in flow reserves room for it. Until this
 * existed the bar simply covered the end of whatever route you were on while
 * a decision was outstanding — on a phone that is up to 78vh, which is most
 * of the screen.
 *
 * The static site solves the same problem by consuming the
 * `--ks-consent-inset` custom property in `apps/site/public/site.css`. The app
 * cannot: `app/+html.tsx` sets `html, body, #root { height: 100% }` and
 * expo-router's `ScrollViewStyleReset` sets `body { overflow: hidden }`, which
 * hands scrolling to React Native `ScrollView`s (`Page.tsx`'s header has the
 * full account). Padding `body` there moves nothing and would only put the
 * fixed-height flex shell at risk, so the app reads the number instead and
 * pads the scroller's content.
 *
 * Starts at 0 rather than reading during render: `expo export` prerenders
 * these routes in Node, where there is no `window`, and a first client render
 * that disagreed with that HTML would be a hydration mismatch. The effect
 * corrects it immediately after mount.
 */
export function useConsentInset(): number {
  const [inset, setInset] = React.useState(0);

  React.useEffect(() => {
    if (typeof window === "undefined") return;

    const read = (): void => {
      const consent = (window as { __ksConsent?: { inset?: number } }).__ksConsent;
      setInset(typeof consent?.inset === "number" ? consent.inset : 0);
    };

    // `consent.js` is `defer`red, so on a fast route it can still be pending
    // when this mounts. Read once for the case where it already ran, then let
    // the event carry every later change — it fires on open, on close, on the
    // panel expanding, and on resize.
    read();
    window.addEventListener("ks-consent-inset", read);
    return () => window.removeEventListener("ks-consent-inset", read);
  }, []);

  return inset;
}

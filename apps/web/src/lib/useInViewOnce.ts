import * as React from "react";
import type { View } from "react-native";

/**
 * True once the referenced node has scrolled within `rootMargin` of the
 * viewport — and stays true forever after. Used to gate an expensive child
 * (an image decode) rather than to unmount/remount it, so a component using
 * this never loses state a sibling depends on by scrolling out of view.
 * Falls back to `true` immediately wherever `IntersectionObserver` is
 * unavailable (jsdom in tests, a very old browser) rather than never
 * rendering the gated content — same posture as `LoadMoreSentinel`.
 */
export function useInViewOnce<T extends View>(rootMargin = "200px"): [React.RefObject<T | null>, boolean] {
  const ref = React.useRef<T>(null);
  // The "no IntersectionObserver" fallback is decided once, in the
  // initializer, rather than via a synchronous `setState` inside the effect
  // below — the latter is a cascading-render anti-pattern the
  // `react-hooks/set-state-in-effect` rule (rightly) rejects, and there's
  // nothing async about `typeof IntersectionObserver` to justify an effect
  // for it in the first place.
  const [visible, setVisible] = React.useState(() => typeof IntersectionObserver === "undefined");

  React.useEffect(() => {
    if (visible) return undefined;
    // react-native-web forwards a View's ref to its underlying DOM node.
    const node = ref.current as unknown as Element | null;
    if (node === null) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
      },
      { rootMargin },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible, rootMargin]);

  return [ref, visible];
}

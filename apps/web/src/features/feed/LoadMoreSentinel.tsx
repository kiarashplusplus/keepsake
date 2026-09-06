// An invisible marker below the "More" button; scrolling it into view
// auto-triggers the next page on web (`IntersectionObserver`). Guarded for
// environments without it (jsdom in tests, or a very old browser) — the
// "More" button next to it is the fallback, not this component's job.
import * as React from "react";
import { View } from "react-native";

export function LoadMoreSentinel({ onVisible }: { onVisible: () => void }): React.ReactElement {
  const ref = React.useRef<View>(null);
  const onVisibleRef = React.useRef(onVisible);

  React.useEffect(() => {
    onVisibleRef.current = onVisible;
  });

  React.useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return undefined;
    // react-native-web forwards a View's ref to its underlying DOM node.
    const node = ref.current as unknown as Element | null;
    if (node === null) return undefined;

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onVisibleRef.current();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return <View ref={ref} accessibilityElementsHidden style={{ height: 1 }} />;
}

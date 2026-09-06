// Reads the reduce-motion preference once and exposes already-tamed motion
// tokens via `useMotion()`. Components never check the preference
// themselves — see `@keepsake/tokens/motion`'s header comment for why
// (Bayan's `motionSafe()` idea: fold the preference in at the token layer).
import * as React from "react";
import { AccessibilityInfo, Platform } from "react-native";
import { motionSafe, type MotionTokens } from "@keepsake/tokens/motion";

const MotionContext = React.createContext<MotionTokens>(motionSafe(false));

export function MotionProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  // Read the web media query as the initial value so the first render is
  // already correct; the effect below only subscribes to changes.
  const [reduce, setReduce] = React.useState<boolean>(() =>
    Platform.OS === "web" && typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  );

  React.useEffect(() => {
    let cancelled = false;

    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (!cancelled) setReduce(value);
    });

    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (value) => {
      setReduce(value);
    });

    let mediaQuery: MediaQueryList | undefined;
    let onChange: ((event: MediaQueryListEvent) => void) | undefined;
    if (Platform.OS === "web" && typeof window !== "undefined" && typeof window.matchMedia === "function") {
      mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
      onChange = (event) => setReduce(event.matches);
      mediaQuery.addEventListener("change", onChange);
    }

    return () => {
      cancelled = true;
      subscription.remove();
      if (mediaQuery && onChange) mediaQuery.removeEventListener("change", onChange);
    };
  }, []);

  const value = React.useMemo(() => motionSafe(reduce), [reduce]);

  return <MotionContext.Provider value={value}>{children}</MotionContext.Provider>;
}

export function useMotion(): MotionTokens {
  return React.useContext(MotionContext);
}

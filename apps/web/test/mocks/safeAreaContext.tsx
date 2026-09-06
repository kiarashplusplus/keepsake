/**
 * Jest-only stand-in for `react-native-safe-area-context`, wired via
 * `jest.config.js`'s `moduleNameMapper`. `src/ui/Page.tsx` calls
 * `useSafeAreaInsets()` for its bottom inset, but route tests `render()`
 * screens directly with no `<SafeAreaProvider>` ancestor (unlike the real
 * app's `app/_layout.tsx`) — and the real hook throws without one, by
 * design, rather than hand back a silently-wrong value.
 *
 * The package ships its own test double at `react-native-safe-area-context/
 * jest/mock`, but it resolves the *real* module internally via
 * `jest.requireActual("react-native-safe-area-context")` — and because
 * `moduleNameMapper` rewrites that specifier too (it's a resolution-time
 * rule, not a mock-only one), that call loops straight back to this file,
 * caching an empty half-built module. A small dependency-free mock, covering
 * only the two exports this app actually imports (checked with a repo-wide
 * grep), sidesteps that entirely.
 */
import * as React from "react";

const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

export function useSafeAreaInsets(): typeof ZERO_INSETS {
  return ZERO_INSETS;
}

export function SafeAreaProvider({ children }: { children?: React.ReactNode }): React.ReactElement {
  return <>{children}</>;
}

/**
 * Jest-only stand-in for `expo-router/head`, wired via `jest.config.js`'s
 * `moduleNameMapper`. The real `Head` (`src/ui/RouteHead.tsx`'s one
 * dependency) calls `useIsFocused()`, which needs a real navigation tree —
 * route tests `render()` screens directly with no `<NavigationContainer>`
 * ancestor (same fact `safeAreaContext.tsx`'s header notes for
 * `useSafeAreaInsets`), and the real hook throws without one.
 *
 * Renders nothing, matching what the real component renders for a screen
 * that isn't the focused one — the state an isolated `render()` is closest
 * to, and the one that can't perturb any existing test's rendered tree.
 * What actually lands in `<head>` at export time is checked against the
 * real `expo export` output, not here.
 */
export default function Head(): null {
  return null;
}

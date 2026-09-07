/** @type {import('jest').Config} */
module.exports = {
  preset: "jest-expo/web",
  transformIgnorePatterns: [
    // `react-native-worklets` added for M1: react-native-reanimated v4 pulls
    // it in as a runtime dependency (the `Seal`/`Skeleton` components use
    // `react-native-reanimated`, first exercised by a render test in M1's
    // give-review test), and it ships ESM (`import ... from`) that Jest's
    // default node_modules skip can't parse without being run through the
    // transform like its sibling packages below.
    //
    // `expo-constants`/`expo-modules-core` added for issue #23's
    // version-skew guard: `src/lib/buildInfo.ts` is the first thing in this
    // app to actually import `expo-constants` (it was previously wired into
    // `app.config.js`'s `extra` but never read at runtime — see
    // `docs/design/ops.md`'s "Version skew" section). `expo-constants` ships
    // an ESM build and `expo-modules-core`'s `main` points straight at its
    // TypeScript source, so both need the same transform every other
    // untranspiled Expo package here gets.
    "node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|expo-constants|expo-modules-core|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules-.*|sentry-expo|native-base|react-native-svg|react-native-reanimated|react-native-worklets|react-native-gesture-handler|react-native-screens|react-native-safe-area-context|react-native-web)/)",
  ],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    // jest-expo/web's own preset merge order is `{...ours, ...preset}`, and
    // the preset's moduleNameMapper (inherited from @react-native/jest-preset)
    // defines a broad `^react-native($|/.*)` entry (pinning every
    // react-native import to one absolute path for monorepo resolution)
    // BEFORE its own web-only `^react-native$` -> `react-native-web`
    // override. Jest tries mappings in insertion order and stops at the
    // first match; since the broad regex's empty-string alternative also
    // matches the bare "react-native" specifier, it always wins, and the
    // web redirect never fires — every `require("react-native")` (including
    // inside @testing-library/react-native's pretty-printer) resolves to
    // real react-native, which throws
    // `Invariant Violation: __fbBatchedBridgeConfig is not set` outside a
    // native bridge. Re-declaring the same key here claims that key's
    // position at merge time (an already-inserted key's value can be
    // overwritten without moving it), so it is tried — and matches — before
    // the preset's broader pattern ever gets a chance to.
    "^react-native$": "react-native-web",
    // See test/mocks/expoImage.tsx's header comment: the real package's
    // native-module dependency chain doesn't run under Jest's jsdom
    // environment.
    "^expo-image$": "<rootDir>/test/mocks/expoImage.tsx",
    // See test/mocks/safeAreaContext.tsx's header comment: `src/ui/Page.tsx`
    // reads `useSafeAreaInsets()`, which throws without a `<SafeAreaProvider>`
    // ancestor — real route tests `render()` screens directly without one.
    "^react-native-safe-area-context$": "<rootDir>/test/mocks/safeAreaContext.tsx",
  },
  setupFiles: ["<rootDir>/test/setup/matchMedia.ts"],
  setupFilesAfterEnv: [],
  // `e2e/` holds Playwright specs, whose `*.spec.ts` names match Jest's
  // default `testMatch` exactly. Without this they'd be collected here, fail
  // on `@playwright/test`'s runner-only imports, and turn a green unit suite
  // red for no reason. `pnpm --filter @keepsake/web e2e` runs them.
  testPathIgnorePatterns: ["/node_modules/", "/dist/", "/.expo/", "/e2e/"],
};

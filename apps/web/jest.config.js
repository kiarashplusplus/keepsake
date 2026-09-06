/** @type {import('jest').Config} */
module.exports = {
  preset: "jest-expo/web",
  transformIgnorePatterns: [
    "node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules-.*|sentry-expo|native-base|react-native-svg|react-native-reanimated|react-native-gesture-handler|react-native-screens|react-native-safe-area-context|react-native-web)/)",
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
  },
  setupFilesAfterEnv: [],
  testPathIgnorePatterns: ["/node_modules/", "/dist/", "/.expo/"],
};

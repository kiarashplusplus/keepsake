/**
 * The one place that reads `expo.extra.buildInfo` at runtime. Everything
 * else (the version-skew guard, any future "you're on build X" debug
 * surface) imports `BUILD_COMMIT` from here rather than touching
 * `expo-constants` directly, so a test can override the value without
 * fighting Expo's config loader.
 *
 * `app.config.js` computes this via `scripts/resolveBuildInfo.mjs`'s
 * `resolveCommitHash()`, which ALWAYS returns a 7-character prefix (either
 * `COMMIT_SHA`/`GITHUB_SHA` sliced to 7, or `git rev-parse --short HEAD`,
 * or the literal string `"dev"` when neither is available). `/version.json`
 * (`apps/api/src/index.ts`) returns the FULL `COMMIT_SHA` the Worker was
 * deployed with. Comparing these two requires `startsWith`, not `===` — see
 * `versionSkew.ts`.
 */
import Constants from "expo-constants";

type BuildInfo = { commitHash?: string; buildDate?: string };

function readBuildInfo(): BuildInfo | undefined {
  const extra = Constants.expoConfig?.extra as { buildInfo?: BuildInfo } | undefined;
  return extra?.buildInfo;
}

export const BUILD_COMMIT: string = readBuildInfo()?.commitHash ?? "dev";

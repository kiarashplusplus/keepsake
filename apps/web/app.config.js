// Dynamic Expo config that extends the static app.base.json and injects
// build-time information (git commit hash + build date) into
// `expo.extra.buildInfo`. Pattern ported from finderly-monorepo
// `frontend/app.config.js` + `frontend/scripts/resolveBuildInfo.js`: the
// resolution logic lives in one shared module (./scripts/resolveBuildInfo.mjs)
// so this file and `scripts/write-version-json.mjs` (which writes
// `dist/version.json`) always agree on the same commit value.
//
// CommonJS on purpose: Expo's config loader evaluates `app.config.js`
// synchronously (an async/Promise-returning config function is a hard
// `ConfigError`) and this package's `package.json` has no
// `"type": "module"`, so `.js` here is CJS. `resolveBuildInfo.mjs` is ESM,
// but Node 22 supports synchronous `require()` of ESM modules that have no
// top-level await, so a plain `require` works here without needing
// `expo export`'s config loader to tolerate an async default export.
const appBase = require("./app.base.json");
const { resolveCommitHash, resolveBuildDate } = require("./scripts/resolveBuildInfo.mjs");

module.exports = () => {
  const base = appBase.expo;

  return {
    ...base,
    extra: {
      ...(base.extra ?? {}),
      buildInfo: {
        commitHash: resolveCommitHash(),
        buildDate: resolveBuildDate(),
      },
    },
  };
};

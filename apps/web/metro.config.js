// Metro config for the pnpm monorepo. Two things a single-package Expo app
// doesn't need:
//   1. `watchFolders` must include the repo root so Metro's haste map picks
//      up changes in `packages/tokens` (a workspace dependency, not
//      published — Metro needs to watch its source, not just node_modules).
//   2. `resolver.nodeModulesPaths` must include both this app's
//      node_modules and the repo root's, because `.npmrc` sets
//      `node-linker=hoisted` (Expo/Metro can't handle pnpm's default
//      isolated symlink layout — broken haste map / autolinking).
//
// `unstable_enablePackageExports` makes Metro respect the `exports` map in
// `packages/tokens/package.json`, which is subpath-only by design (see
// packages/tokens/package.json + eslint.config.mjs's barrel ban) — without
// this flag Metro falls back to `main`/legacy resolution and subpath
// specifiers like `@keepsake/tokens/colors` fail to resolve.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "..", "..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = Array.from(new Set([...(config.watchFolders || []), monorepoRoot]));

config.resolver = {
  ...config.resolver,
  nodeModulesPaths: [
    path.resolve(projectRoot, "node_modules"),
    path.resolve(monorepoRoot, "node_modules"),
  ],
  unstable_enablePackageExports: true,
};

module.exports = config;

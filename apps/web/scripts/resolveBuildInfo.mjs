// Shared commit-hash resolution, used by BOTH:
//   - `apps/web/app.config.js` (injects into expo.extra.buildInfo, read at
//     runtime for a build stamp / future version-skew guard)
//   - `apps/web/scripts/write-version-json.mjs` (writes `dist/version.json`
//     next to the exported static shell)
//
// Extracted to one module so both call sites resolve the EXACT same commit
// value from the EXACT same env vars — ported from the finderly-monorepo
// pattern (frontend/scripts/resolveBuildInfo.js) that exists because a
// version-skew guard comparing two independently-resolved values is either
// always silent or always noisy.
//
// Resolution order (first non-empty wins):
//   1. process.env.COMMIT_SHA        (explicit override, CI/deploy)
//   2. process.env.GITHUB_SHA        (GitHub Actions default)
//   3. `git rev-parse --short HEAD`  (local checkout)
//   4. "dev"                          (no env, no git — e.g. a tarball)
//
// All git invocations are wrapped in try/catch so a missing git binary or a
// build context without `.git` never fails the build — callers just fall
// through to the next tier.
import { execSync } from "node:child_process";

function safeExec(cmd) {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

export function resolveCommitHash() {
  const fromEnv = process.env.COMMIT_SHA || process.env.GITHUB_SHA || "";
  if (fromEnv) return fromEnv.slice(0, 7);
  const fromGit = safeExec("git rev-parse --short HEAD");
  return fromGit || "dev";
}

export function resolveBuildDate() {
  return new Date().toISOString();
}

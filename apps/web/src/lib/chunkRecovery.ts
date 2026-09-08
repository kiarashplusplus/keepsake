/**
 * Pure classifier for a failed dynamically-imported route chunk (issue
 * #272). Route splitting (`asyncRoutes`, #262) means navigating to a route
 * whose JS hasn't loaded yet fetches its own content-hashed chunk under
 * `_expo/static/*`; a deploy rotates those hashes, so a tab left open
 * across one can navigate to a route it hasn't already loaded and request
 * a chunk that no longer exists. `apps/api/src/index.ts` now answers that
 * miss with a real, uncached 404 instead of the SPA shell (so the failure
 * is diagnosable in the network panel), but nothing upstream of this file
 * makes the failed `import()` itself recoverable — it just rejects, and the
 * navigation silently doesn't render.
 *
 * Kept dependency-free and side-effect-free, same as `versionSkew.ts`, so
 * the classifier is trivial to unit test without mounting anything or
 * touching `window` — `useChunkRecoveryGuard.ts` is the only thing that
 * actually listens for `unhandledrejection` and reloads.
 */

/**
 * The wording browsers/engines actually use for a failed dynamic
 * `import()` isn't one string. Matched case-insensitively rather than
 * pinned to one: Chromium's "Failed to fetch dynamically imported module:
 * <url>", Firefox's "error loading dynamically imported module: <url>",
 * the generic "Importing a module script failed" some engines fall back to
 * when the reason is unavailable, and "Loading module <url> failed." —
 * observed directly against the pinned headless-shell build this repo's
 * e2e suite runs (`AGENTS.md`'s note on `PLAYWRIGHT_BROWSERS_PATH`), and
 * the one that actually fires for expo-router's `React.lazy`-wrapped
 * routes (see `useChunkRecoveryGuard.ts`'s header comment).
 */
const CHUNK_LOAD_ERROR_PATTERNS: readonly RegExp[] = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /loading module .* failed/i,
];

/**
 * The one path prefix `apps/api/src/index.ts` now answers truthfully — a
 * real 404, not the SPA shell — for a miss (see that file's #272 comment).
 * A rejection naming a URL under this prefix is unambiguously a missing
 * route chunk, not some other fetch failure that happens to share wording.
 */
export const CHUNK_PATH_PREFIX = "/_expo/static/";

/** `sessionStorage` key guarding the one-time reload in
 * `useChunkRecoveryGuard.ts`, so a chunk that's genuinely missing on the
 * fresh build too (a broken deploy, not stale skew) can't reload forever. */
export const CHUNK_RECOVERY_RELOAD_FLAG = "keepsake:chunk-recovery-reloaded";

function messageOf(reason: unknown): string {
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  return "";
}

/**
 * True when `reason` — an `unhandledrejection` event's `.reason`, or any
 * other thrown/rejected value — looks like a failed dynamic import of a
 * route chunk. Two independent signals, either is enough: the message
 * wording browsers use for a failed `import()`, or the failing module's URL
 * sitting under the hashed-chunk prefix (present in some engines' messages,
 * and available separately to a caller that already has it, e.g. from a
 * `<script>`/`error` event's `target`).
 */
export function isChunkLoadFailure(reason: unknown, failingUrl?: string): boolean {
  const message = messageOf(reason);
  if (CHUNK_LOAD_ERROR_PATTERNS.some((pattern) => pattern.test(message))) return true;
  if (message.includes(CHUNK_PATH_PREFIX)) return true;
  if (failingUrl !== undefined && failingUrl.includes(CHUNK_PATH_PREFIX)) return true;
  return false;
}

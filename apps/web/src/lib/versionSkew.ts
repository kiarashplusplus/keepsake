/**
 * Pure logic for the version-skew guard (issue #23). Kept dependency-free
 * and side-effect-free so it's trivial to unit test without mounting
 * anything — `useVersionSkewGuard.ts` is the only thing that calls fetch.
 */

/** `resolveBuildInfo.mjs`'s fallback when there's no `COMMIT_SHA`/`GITHUB_SHA`
 * and no `.git` to shell out to (a tarball, or a from-scratch local dev
 * server). `/version.json` falls back to the same literal when `COMMIT_SHA`
 * is unset on the Worker (see `apps/api/src/index.ts`). Neither side can be
 * meaningfully compared against "dev" — the guard has to stay quiet rather
 * than nag every local/preview session that never got a real commit
 * stamped in, which is exactly the kind of always-noisy check
 * `resolveBuildInfo.mjs`'s own header comment warns about. */
export const UNSTAMPED_COMMIT = "dev";

/**
 * `buildCommit` is the 7-character prefix baked into the bundle at export
 * time; `serverCommit` is the full SHA `/version.json` returns right now.
 * `startsWith`, not `===`, is the whole point of this function existing —
 * see `buildInfo.ts`'s header comment for why a strict-equals comparison
 * would be permanently, silently stale.
 */
export function isVersionStale(buildCommit: string, serverCommit: string): boolean {
  if (buildCommit === UNSTAMPED_COMMIT || serverCommit === UNSTAMPED_COMMIT) return false;
  if (buildCommit === "" || serverCommit === "") return false;
  return !serverCommit.startsWith(buildCommit);
}

/** Poll every 5 minutes while the tab is open — frequent enough that a
 * deploy is noticed within one coffee break, infrequent enough that a tab
 * left open all day makes single-digit requests, not hundreds. */
export const POLL_INTERVAL_MS = 5 * 60 * 1000;

/** A focus/visibility event re-checks immediately, but never more often
 * than this — switching tabs back and forth shouldn't turn into a fetch
 * storm. */
export const MIN_FOCUS_POLL_GAP_MS = 60 * 1000;

/**
 * The exact class of dead check this repo keeps shipping: a guard that
 * polls an endpoint the browser (or an intermediate cache) is allowed to
 * answer from cache, so the poll technically runs forever and never once
 * observes a change. `/version.json` sends `Cache-Control: no-store`
 * (`apps/api/src/index.ts`, asserted by `apps/api/test/health.test.ts`), so
 * this should always be `false` in production — this function exists so a
 * regression on either side (a CDN rule, a future refactor that drops the
 * header) fails loudly instead of turning the guard back into decoration.
 */
export function responseIsCacheable(cacheControl: string | null): boolean {
  if (cacheControl === null) return true;
  const directives = cacheControl.toLowerCase();
  return !directives.includes("no-store");
}

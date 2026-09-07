/**
 * The client half of the version-skew guard (issue #23). The server half
 * (`GET /version.json`, `apps/api/src/index.ts`) already existed and was
 * already correct; nothing polled it. This hook is that missing poll.
 *
 * Mounted once, at the root (`app/_layout.tsx`), by `VersionSkewBanner`.
 *
 * Deliberately does NOT reload anything itself. `reload()` is exposed for a
 * button to call — never invoked automatically — because a giver mid-way
 * through the give flow's story step, or typing a request note in
 * `RequestSheet`, must never have the page pulled out from under them. The
 * worst this hook does unattended is show a dismissible banner.
 */
import * as React from "react";
import { BUILD_COMMIT } from "@/lib/buildInfo";
import { isVersionStale, responseIsCacheable, MIN_FOCUS_POLL_GAP_MS, POLL_INTERVAL_MS } from "@/lib/versionSkew";

type VersionResponse = { commit?: unknown };

export type VersionSkewGuardState = {
  /** True once a poll has seen a server commit that doesn't match this
   * build AND the visitor hasn't dismissed that exact commit yet. */
  stale: boolean;
  /** The server commit that triggered `stale`, for a "what changed" link
   * or a test assertion — `null` before the first mismatch is seen. */
  latestCommit: string | null;
  /** Hides the banner until a *further* deploy happens (a later poll
   * returns yet another commit). Does not stop polling. */
  dismiss: () => void;
  /** The one place that actually reloads the page. Only ever called from a
   * button the visitor pressed. */
  reload: () => void;
};

function hasBrowserApis(): boolean {
  return typeof window !== "undefined" && typeof window.fetch === "function";
}

// Warn at most once per session even if the header regresses on every
// single poll — this is a "tell a developer once", not a user-facing thing.
let hasWarnedAboutCacheability = false;

export function useVersionSkewGuard(options?: { buildCommit?: string }): VersionSkewGuardState {
  const buildCommit = options?.buildCommit ?? BUILD_COMMIT;
  const [latestCommit, setLatestCommit] = React.useState<string | null>(null);
  const [dismissedCommit, setDismissedCommit] = React.useState<string | null>(null);

  // Everything that talks to `/version.json` lives inside this one effect,
  // deliberately NOT pulled out into a `useCallback` the effect then calls:
  // this repo's `react-hooks/set-state-in-effect` lint rule flags a
  // memoized callback reference invoked from an effect body as "calling
  // setState directly within an effect" even though the actual `setState`
  // only happens after an `await` — see `useFeed.ts`'s identical note. An
  // inline async function declared and called from *within* the effect
  // (subscribing an external system — the timer, the focus/visibility
  // events — and calling setState from their callbacks) is the pattern the
  // rule expects.
  React.useEffect(() => {
    if (!hasBrowserApis()) return undefined;

    let lastCheckedAt = 0;
    let inFlight = false;

    async function check(): Promise<void> {
      if (inFlight) return;
      inFlight = true;
      lastCheckedAt = Date.now();
      try {
        // `cache: "no-store"` belt-and-braces the server's own
        // `Cache-Control: no-store` (apps/api/src/index.ts) — a browser's
        // back-forward cache or an intermediate proxy honoring a
        // *different* header on the same response is exactly the failure
        // mode that would make this poll decorative, so both sides refuse
        // to be cached independently.
        const res = await window.fetch("/version.json", { cache: "no-store" });
        if (!res.ok) return;

        if (responseIsCacheable(res.headers.get("cache-control")) && !hasWarnedAboutCacheability) {
          hasWarnedAboutCacheability = true;
          console.warn(
            "[version-skew] /version.json responded without Cache-Control: no-store — the version-skew guard may never see a new deploy.",
          );
        }

        const body = (await res.json()) as VersionResponse;
        if (typeof body.commit !== "string") return;
        setLatestCommit(body.commit);
      } catch {
        // Offline, or the Worker is between deploys and briefly unreachable —
        // either way, silently try again on the next interval/focus tick
        // rather than surfacing a network error for a background poll.
      } finally {
        inFlight = false;
      }
    }

    void check();
    const interval = window.setInterval(() => void check(), POLL_INTERVAL_MS);

    const maybeCheck = () => {
      if (Date.now() - lastCheckedAt >= MIN_FOCUS_POLL_GAP_MS) void check();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") maybeCheck();
    };

    window.addEventListener("focus", maybeCheck);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", maybeCheck);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const stale = latestCommit !== null && latestCommit !== dismissedCommit && isVersionStale(buildCommit, latestCommit);

  const dismiss = React.useCallback(() => {
    setDismissedCommit(latestCommit);
  }, [latestCommit]);

  const reload = React.useCallback(() => {
    if (hasBrowserApis()) window.location.reload();
  }, []);

  return { stale, latestCommit, dismiss, reload };
}

/**
 * The client half of the chunk-load recovery guard (issue #272). Route
 * splitting (`asyncRoutes`, #262) means a route's JS arrives as its own
 * content-hashed chunk on navigation; a deploy rotates those hashes, so a
 * tab left open across one can request a chunk that no longer exists. No
 * router error boundary catches this — the import fails before the route
 * component exists to catch anything — so this listens at the window level
 * for BOTH ways the failure can surface, measured directly against
 * expo-router's real lazy-loading (`useScreens.js`'s `React.lazy(() =>
 * value.loadRoute().then(...))`), not assumed from how a bare `import()`
 * behaves: React.lazy attaches its own `.then(resolve, reject)` to that
 * promise the moment the lazy component is first rendered, which means
 * something *did* handle the rejection and the browser never fires
 * `unhandledrejection` for it. What actually happens is React re-throws the
 * rejection reason as a plain synchronous error on the *next* render pass —
 * an ordinary uncaught exception (`window`'s `error` event), not a promise
 * rejection. `unhandledrejection` is kept too, both because it is the
 * documented shape for a raw failed `import()` elsewhere in the app and
 * because it costs nothing to also catch a case not exercised by the
 * lazy-route path specifically.
 *

 * Mounted once, at the root (`app/_layout.tsx`), same as
 * `useVersionSkewGuard`. Unlike that guard, this one *does* reload on its
 * own: unlike a version-skew banner (which waits for a click, because a
 * giver mid-story must never have the page pulled out from under them), a
 * chunk-load failure has already broken the navigation the visitor just
 * made — there is no unsaved state on the failed screen to protect, because
 * it never rendered. The new bundle is what they wanted anyway; its
 * `index.html` points at the new hashes.
 *
 * Guarded against a reload loop with a `sessionStorage` flag
 * (`CHUNK_RECOVERY_RELOAD_FLAG`): if the fresh bundle's chunk is *also*
 * missing (a broken deploy, not stale skew), this fires the reload at most
 * once per tab rather than looping forever.
 */
import * as React from "react";
import { isChunkLoadFailure, CHUNK_RECOVERY_RELOAD_FLAG } from "@/lib/chunkRecovery";

function hasBrowserApis(): boolean {
  return typeof window !== "undefined" && typeof window.addEventListener === "function";
}

// try/catch around every sessionStorage touch: private-mode Safari and a
// locked-down embed can both throw on read or write even though the API
// exists. Losing the guard in that case risks one extra reload, not a loop
// that would outlive the tab close that clears it anyway.
function alreadyReloaded(): boolean {
  try {
    return hasBrowserApis() && window.sessionStorage.getItem(CHUNK_RECOVERY_RELOAD_FLAG) === "1";
  } catch {
    return false;
  }
}

function markReloaded(): void {
  try {
    if (hasBrowserApis()) window.sessionStorage.setItem(CHUNK_RECOVERY_RELOAD_FLAG, "1");
  } catch {
    // See alreadyReloaded's comment.
  }
}

export function useChunkRecoveryGuard(): void {
  React.useEffect(() => {
    if (!hasBrowserApis()) return undefined;

    const recover = (reason: unknown, failingUrl?: string): void => {
      if (!isChunkLoadFailure(reason, failingUrl)) return;
      if (alreadyReloaded()) return;
      // Mark BEFORE reloading, not after: reload() doesn't return, so
      // "after" would never run.
      markReloaded();
      window.location.reload();
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => recover(event.reason);
    // The one that actually fires for expo-router's lazy routes — see this
    // file's header comment. `event.error` is undefined for some browsers'
    // cross-origin-script case, which can't apply to a same-origin chunk;
    // `event.message` alone still carries the URL this classifier looks for.
    const onError = (event: ErrorEvent) => recover(event.error ?? event.message, event.filename);

    window.addEventListener("unhandledrejection", onUnhandledRejection);
    window.addEventListener("error", onError);
    return () => {
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
      window.removeEventListener("error", onError);
    };
  }, []);
}

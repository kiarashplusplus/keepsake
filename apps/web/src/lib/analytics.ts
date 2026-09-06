/**
 * `track()` is a no-op wrapper for now (M0 — no analytics provider wired
 * yet; this is the seam a future CF Web Analytics / product-events pipeline
 * plugs into without touching every call site).
 *
 * Rule (ported from finderly-monorepo `frontend/src/utils/analytics.ts`'s
 * header comment, ~line 529): **never call track() from a render body.**
 * Every call site is responsible for guarding against duplicate fires on
 * re-render — call from event handlers, a `useEffect` with stable deps, a
 * ref, or a navigation listener, never from the body of a render function.
 */
export function track(name: string, props?: Record<string, unknown>): void {
  if (__DEV__) {
    console.debug("[analytics]", name, props ?? {});
  }
}

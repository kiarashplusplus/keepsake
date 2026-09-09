/**
 * The "first visit to `/`" switch, and the one place it is read or cleared.
 *
 * `app/+html.tsx`'s pre-hydration script decides, before anything paints,
 * whether this load of `/` is a device's first: no owner token, no
 * `keepsake.visited.v1` flag, no `?q=`. When it is, the script puts
 * `data-ks-first-visit="1"` on `<html>` — and that attribute is the entire
 * state. `app/index.tsx` renders **both** the explainer and the feed into
 * every `/`, and the stylesheet the same shell declares
 * (`--ks-first-visit-only` / `--ks-returning-only`) shows exactly one of
 * them, keyed on that attribute. Same construction as the theme and the
 * viewport switch: the decision is made in CSS from a value set before the
 * first paint, on markup that is identical either way, so there is no flash,
 * no hydration mismatch, and no `Vary` on the one URL that has to stay
 * cacheable for everyone.
 *
 * ## Why this replaced a redirect
 *
 * Until 2026-09-09 that script did `location.replace("/welcome")` instead.
 * Google's renderer clears storage between loads, so every render of `/`
 * was a first visit, and a JavaScript `location.replace` is a redirect to a
 * crawler — PageSpeed Insights reported the homepage as "Clientside
 * Redirect! … Updated URL https://keepsake.ing/welcome", and Search Console
 * would have recorded the single most valuable URL this product has as a
 * page that redirects. The explainer now shows *at* `/`, so `/` answers
 * `200` with its own content for everyone, and `/welcome` stays what it
 * always was: a linkable page that says what this is.
 *
 * ## What React needs it for
 *
 * The CSS does the showing and hiding; React only needs the value for two
 * things — not fetching the feed while it is hidden behind the explainer,
 * and switching to the feed in place when the explainer's "See what's out
 * there" is pressed (`endFirstVisit`). `useSyncExternalStore` rather than
 * `useState` + effect because the server snapshot (`false`: a static render
 * has no `<html>` attribute to read) and the client's genuinely differ, and
 * this is the hook React provides for exactly that. The markup does not
 * depend on the value, so the post-hydration re-render changes nothing on
 * screen.
 *
 * Native has no pre-hydration script and no attribute, so `isFirstVisit` is
 * always `false` there and the explainer wrapper is `display: none`.
 */
import * as React from "react";
import { Platform, type ViewStyle } from "react-native";

/** `data-ks-first-visit` on `<html>`, as `dataset` spells it. */
const DATASET_KEY = "ksFirstVisit";

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The pre-hydration script's answer, read straight off `<html>`. */
export function isFirstVisit(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.dataset[DATASET_KEY] === "1";
}

/** A static render has no document, and must not guess. */
function NEVER_ON_SERVER(): boolean {
  return false;
}

/**
 * "See what's out there": clear the attribute, which is what the stylesheet
 * keys on, and tell React so the feed starts loading. Idempotent — a second
 * call finds nothing to clear and notifies nobody of a change.
 */
export function endFirstVisit(): void {
  if (typeof document === "undefined") return;
  if (document.documentElement.dataset[DATASET_KEY] === undefined) return;
  delete document.documentElement.dataset[DATASET_KEY];
  for (const listener of listeners) listener();
}

export function useFirstVisit(): boolean {
  return React.useSyncExternalStore(subscribe, isFirstVisit, NEVER_ON_SERVER);
}

/**
 * The two wrappers `app/index.tsx` puts around its screens, inside the one
 * `Page`. On the web each `display` is a custom property the shell's
 * stylesheet resolves from the `<html>` attribute (see `FIRST_VISIT_CSS` in
 * `app/+html.tsx`), so which screen is on the page is decided before
 * JavaScript runs. The `as unknown as` cast is the same escape hatch
 * `src/ui/viewport.web.ts` uses for a `var()` react-native's types do not
 * model.
 */
export const firstVisitOnly: ViewStyle =
  Platform.OS === "web"
    ? ({ display: "var(--ks-first-visit-only, none)" } as unknown as ViewStyle)
    : { display: "none" };

export const returningOnly: ViewStyle =
  Platform.OS === "web"
    ? ({ display: "var(--ks-returning-only, flex)" } as unknown as ViewStyle)
    : {};

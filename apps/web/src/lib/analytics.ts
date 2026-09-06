/**
 * `track()` is still a no-op wrapper for product events — there is no
 * first-party events pipeline yet; this is the seam one plugs into without
 * touching every call site. What changed is that it is now behind the consent
 * gate, so the seam cannot be filled in later by someone who does not know
 * a gate was supposed to exist.
 *
 * The measured analytics that DOES ship is Cloudflare Web Analytics, and it is
 * loaded by `/consent.js` (`apps/web/public/consent.js`), not from here: a
 * cookieless beacon is a page-level script tag, and putting its injection next
 * to the decision that authorises it is the whole point. `config.cfWebAnalytics
 * Token` empty means it never loads at all, in any environment.
 *
 * `docs/runbooks/launch-audit.md` §7 found `privacy.html` asserting as
 * present-tense fact that Cloudflare Web Analytics was running while this file
 * was a no-op that said "no analytics provider wired yet". The code and the
 * page now agree, and `test/guards/privacyPolicy.test.ts` fails the build if
 * they stop agreeing.
 *
 * Rule (ported from finderly-monorepo `frontend/src/utils/analytics.ts`'s
 * header comment, ~line 529): **never call track() from a render body.**
 * Every call site is responsible for guarding against duplicate fires on
 * re-render — call from event handlers, a `useEffect` with stable deps, a
 * ref, or a navigation listener, never from the body of a render function.
 */
import { isAnalyticsAllowed } from "@/lib/consent";

export function track(name: string, props?: Record<string, unknown>): boolean {
  // Checked at call time, not at module load: the visitor can accept, or
  // withdraw, at any point in a session, and a flag captured at import would
  // be the stale answer for the rest of it.
  if (!isAnalyticsAllowed()) return false;
  if (__DEV__) {
    console.debug("[analytics]", name, props ?? {});
  }
  return true;
}

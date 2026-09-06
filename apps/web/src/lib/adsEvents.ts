/**
 * Google Ads conversions.
 *
 * Two conventions, both carried over deliberately:
 *
 *  1. **One constants file.** Same rule as `analyticsEvents.ts`: the label for
 *     a conversion is named here, never inlined at a call site, so a rename is
 *     one edit instead of a grep-and-pray.
 *
 *  2. **Nothing fires from a render body.** Same rule as `analytics.ts`. Call
 *     `trackConversion` from an event handler, a `useEffect` with stable deps,
 *     or a navigation listener — never from the body of a render function,
 *     where React's re-renders (and Strict Mode's double invoke) turn one
 *     conversion into several.
 *
 * The distinction Finderly's `dataLayerEvents.ts` draws is worth restating,
 * because it cost that project every conversion it ever should have recorded:
 * the names in `analyticsEvents.ts` are OUR product telemetry and can be
 * renamed freely, while the identifiers here are a WIRE CONTRACT with a
 * conversion action configured in the Google Ads UI. Renaming one side without
 * the other does not fail; it just silently stops counting. Finderly renamed
 * an event for tidiness, the GTM trigger kept listening for the old string,
 * and Google Ads received zero conversions for the entire life of the
 * pipeline. So: change a label here only when you have changed the matching
 * conversion action, and `test/lib/adsEvents.test.ts` asserts each one is
 * wired to a distinct env var so two conversions can never collapse into one.
 *
 * Finderly's server-side upload path, its eLocal paid/engagement split, and
 * its GTM container are NOT ported. Keepsake has no money changing hands and
 * no GTM container; gtag.js loaded directly is the whole pipeline.
 */
import { config } from "@/lib/config";
import { isAdvertisingAllowed } from "@/lib/consent";

/**
 * The conversions Keepsake reports. The value is the *env var suffix*, not the
 * label itself: labels are per-account strings from the Google Ads UI and have
 * no business being committed.
 */
export const AdsConversions = {
  /**
   * A listing went LIVE — not merely submitted. Moderation can still reject
   * it, and bidding toward submissions optimises for people who like the form
   * rather than people who give something away. `app/give/review.tsx` fires it
   * from the same status-transition effect that guards `AnalyticsEvents.
   * GiveLive` with a ref, so a poll that re-reports "approved" cannot count
   * twice.
   */
  GiveLive: "give",
  /** Someone asked for a keepsake. A weaker, denser signal than the above. */
  RequestSent: "request",
} as const;

export type AdsConversionName = (typeof AdsConversions)[keyof typeof AdsConversions];

const LABELS: Record<AdsConversionName, string> = {
  give: config.googleAdsGiveLabel,
  request: config.googleAdsRequestLabel,
};

type GtagFn = (command: string, action: string, params?: Record<string, unknown>) => void;

function gtag(): GtagFn | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { gtag?: GtagFn }).gtag ?? null;
}

/**
 * Report a conversion, if and only if every one of these holds:
 *
 *   - the visitor granted the advertising category (and is not sending GPC —
 *     `isAdvertisingAllowed()` reads the *effective* decision, so a stored
 *     grant from before they turned GPC on does not out-rank the signal they
 *     are sending now);
 *   - a Google Ads tag id is configured for this build;
 *   - this conversion has a label configured.
 *
 * Returns whether anything was sent, so a test can assert the negative rather
 * than assert on a console. Never throws: a measurement failure must not take
 * a give or a request down with it.
 */
export function trackConversion(name: AdsConversionName, params?: Record<string, unknown>): boolean {
  if (!isAdvertisingAllowed()) return false;
  const label = LABELS[name];
  if (!config.googleAdsId || !label) return false;
  const send = gtag();
  if (!send) return false;
  try {
    send("event", "conversion", { ...params, send_to: `${config.googleAdsId}/${label}` });
    return true;
  } catch {
    return false;
  }
}

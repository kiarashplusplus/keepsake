/**
 * Public runtime config, read once from `EXPO_PUBLIC_*` env vars. Everything
 * here is baked verbatim into the client bundle at build time (Expo inlines
 * `EXPO_PUBLIC_*` via babel-preset-expo) — see `test/guards/publicEnv.test.ts`,
 * which scans the whole app for any `EXPO_PUBLIC_*` name that looks like it's
 * trying to smuggle a secret through. Never add anything secret-shaped here.
 */

export type Env = "development" | "preview" | "production";

export type Config = {
  /** Base URL for API calls. Empty string means same-origin (the Worker
   * serves both the SPA and /api/* in preview/production). */
  siteUrl: string;
  /** Cloudflare Turnstile widget site key. Empty until the widget is
   * provisioned — `Turnstile.web.tsx` renders nothing and reports
   * `{status:"unconfigured"}` in that case (a caller treats that the same
   * as a valid token for enabling submit), so the flow still works before
   * it exists. */
  turnstileSiteKey: string;
  /**
   * Google Ads tag id (`AW-…`). Public by design — it is visible in the page
   * source of every site that runs the tag; that is how the product works.
   *
   * Read here AND emitted as `<meta name="ks-google-ads-id">` by
   * `app/+html.tsx`, because `/consent.js` is a static file that owns the
   * loading and cannot see `process.env`. The value reaching the bundle is
   * also what makes `scripts/verify-public-env.mjs` pass: a variable that
   * only ever appeared in the static HTML shell would not be found in
   * `dist/_expo/static/js/web/*.js` and would fail that check.
   *
   * Empty means Google Ads is not configured: `/consent.js` loads nothing and
   * `adsEvents.ts` sends nothing, in any environment, whatever the visitor
   * consented to.
   */
  googleAdsId: string;
  /** Conversion labels, paired with `googleAdsId` to form gtag's `send_to`. */
  googleAdsGiveLabel: string;
  googleAdsRequestLabel: string;
  /**
   * Cloudflare Web Analytics beacon token. Public by design (it is in the
   * `data-cf-beacon` attribute on every page that runs it) — hence its place
   * on the `EXPO_PUBLIC_*` allowlist in `test/guards/publicEnv.test.ts` and
   * `tools/preflight/preflight.mjs`. Empty means no analytics loads at all.
   */
  cfWebAnalyticsToken: string;
  env: Env;
};

function isEnv(value: string | undefined): value is Env {
  return value === "development" || value === "preview" || value === "production";
}

const rawEnv = process.env.EXPO_PUBLIC_ENV;

export const config: Config = {
  siteUrl: process.env.EXPO_PUBLIC_SITE_URL ?? "",
  turnstileSiteKey: process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY ?? "",
  googleAdsId: process.env.EXPO_PUBLIC_GOOGLE_ADS_ID ?? "",
  googleAdsGiveLabel: process.env.EXPO_PUBLIC_GOOGLE_ADS_GIVE_LABEL ?? "",
  googleAdsRequestLabel: process.env.EXPO_PUBLIC_GOOGLE_ADS_REQUEST_LABEL ?? "",
  cfWebAnalyticsToken: process.env.EXPO_PUBLIC_CF_WEB_ANALYTICS_TOKEN ?? "",
  env: isEnv(rawEnv) ? rawEnv : "development",
};

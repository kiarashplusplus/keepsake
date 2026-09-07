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
  /*
   * There were three Google Ads fields here — `googleAdsId`,
   * `googleAdsGiveLabel`, `googleAdsRequestLabel`, each `process.env.
   * EXPO_PUBLIC_GOOGLE_ADS_* ?? ""`. **Removed 2026-09-07, Kiarash's
   * decision: no Google Ads for now** (issue #175).
   *
   * They were read here for the whole life of the feature while
   * `deploy.yml`'s export step passed none of them, so all three inlined as
   * `""` in every deployed bundle and `adsEvents.ts` returned early on every
   * call. A `?? ""` fallback is what made that invisible: an unconfigured
   * value and a forgotten one are the same empty string, and nothing
   * distinguished them.
   *
   * `/consent.js`'s advertising category is deliberately still there and
   * still tested — it is unfed, not removed. It keys off
   * `<meta name="ks-google-ads-id">`, which `app/+html.tsx` and every
   * `apps/site` page now emit with a hardcoded empty `content`. That is the
   * loader's own kill switch: it fails the `/^(AW|G|GT)-/` test and returns
   * before touching the network. Left declared-and-empty rather than deleted
   * so the pages stay in sync with consent.js's provider registry, which
   * `test/guards/privacyPolicy.test.ts` enforces.
   *
   * Turning ads back on means restoring these fields, `.env.example`'s block,
   * `deploy.yml`'s env keys and the GitHub Environment values *together* —
   * and re-reading `docs/legal-considerations.md`'s Rhode Island paragraph,
   * which turns on whether a tag actually loads.
   */
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
  cfWebAnalyticsToken: process.env.EXPO_PUBLIC_CF_WEB_ANALYTICS_TOKEN ?? "",
  env: isEnv(rawEnv) ? rawEnv : "development",
};

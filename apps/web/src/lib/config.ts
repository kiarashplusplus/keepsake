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
   * provisioned — `Turnstile.web.tsx` renders nothing and reports a token of
   * `""` in that case, so the flow still works before it exists. */
  turnstileSiteKey: string;
  env: Env;
};

function isEnv(value: string | undefined): value is Env {
  return value === "development" || value === "preview" || value === "production";
}

const rawEnv = process.env.EXPO_PUBLIC_ENV;

export const config: Config = {
  siteUrl: process.env.EXPO_PUBLIC_SITE_URL ?? "",
  turnstileSiteKey: process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY ?? "",
  env: isEnv(rawEnv) ? rawEnv : "development",
};

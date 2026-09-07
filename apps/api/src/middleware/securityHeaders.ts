/**
 * Issue #10: nothing in the app returned CSP, `X-Frame-Options`,
 * `Referrer-Policy`, `Strict-Transport-Security`, or `X-Content-Type-Options`
 * on any response. Two concrete risks named in the issue: the recovery link
 * puts a live credential in a URL (`/recover/<token>`), and the give flow and
 * admin page could be framed.
 *
 * `apps/web/public/_headers` covers the other half of this fix — the SPA
 * shell and static files, which are served by the Cloudflare assets binding,
 * the only thing that reads `_headers`. This middleware exists for the
 * responses that binding never touches: `/item/:id` (`routes/item.ts`'s
 * HTMLRewriter-rewritten copy of the same shell) and every `/api/*` JSON
 * response. Applied globally (`app.use("*", ...)`, alongside the `requestId`
 * middleware in `index.ts`) rather than only on those two, since headers set
 * here after `next()` just overwrite whatever a downstream handler (or the
 * `ASSETS` fallback route) already set with the identical value — cheap, and
 * one less place a future new route could slip through unheadered.
 *
 * The CSP string is deliberately identical to the one in
 * `apps/web/public/_headers`, not a stricter "JSON doesn't need scripts"
 * variant: `/item/:id` serves the real exported HTML shell (same inline
 * `PREHYDRATION_SCRIPT` and Expo Router hydration script as every other
 * route), so a mismatched policy here would silently break theming (and,
 * since issue #44, the new-visitor redirect) on that one route only — see
 * that file's comment for what each `script-src` hash is and why
 * `style-src` keeps `'unsafe-inline'`. Kept as a second literal
 * copy rather than a shared import: the two are read by unrelated runtimes
 * (a Worker module vs. a static `_headers` file consumed by the assets
 * binding) with no natural common module to hold one shared constant.
 *
 * `https://www.googletagmanager.com` and `https://static.cloudflareinsights.com`
 * are in `script-src` for `apps/web/public/consent.js`'s `injectScript()` —
 * the Google Ads tag and Cloudflare Web Analytics beacon, both loaded only
 * after the consent gate grants them (`e2e/consent.spec.ts`). Without these,
 * the browser's own CSP enforcement silently drops the `<script src>` before
 * it ever reaches the network — a strictly worse failure than not having a
 * CSP at all, since nothing throws and nothing logs outside the browser
 * console. Caught by that same e2e suite once this middleware and the
 * pre-existing consent loader ran together for the first time.
 */
import type { Context, Next } from "hono";
import type { Env } from "../env.js";

type SecurityHeadersCtx = Context<{ Bindings: Env }>;

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com https://www.googletagmanager.com https://static.cloudflareinsights.com " +
    "'sha256-Fv9zzPneZXpo0yUSzp9eTrF6T5uzfynr6qZUJVoOQ8g=' " +
    "'sha256-67fhrP0+BkBqmgGGXTtgiVO/9EQs3QruYNU/7fnRkI8=' " +
    "'sha256-d6qbtEYff/sB38YyzuzhASbVmmOidU/UFC9mNit47j4='",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "frame-src https://challenges.cloudflare.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

export function securityHeaders() {
  return async (c: SecurityHeadersCtx, next: Next) => {
    await next();
    c.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    // Belt-and-braces alongside `frame-ancestors` above: older browsers that
    // don't understand that CSP directive still honor this one.
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    // Cloudflare terminates TLS for every real request; browsers ignore this
    // header on a plain-http response per spec, so setting it unconditionally
    // (rather than gating on `isProduction(c.env)`) is safe in local dev too.
    c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
    c.header("X-Content-Type-Options", "nosniff");
  };
}

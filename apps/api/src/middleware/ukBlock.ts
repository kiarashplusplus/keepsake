/**
 * Geo-blocks the UK for launch — a deliberate decision, not an accident.
 * Full reasoning, and exactly what would have to be true to lift it, lives
 * in `docs/runbooks/uk-block.md`; read that before touching this file.
 *
 * Short version: the Online Safety Act has no small-service exemption for
 * its base duties (a written illegal-content risk assessment, a children's
 * access assessment whose deadline has already passed, a complaints
 * procedure, and record-keeping). Rather than take those on for a
 * zero-revenue, one-person product, Kiarash chose to geo-block instead.
 *
 * This is the *visitor* half of that decision. `@keepsake/contracts/geo`
 * already dropped `GB` from `COUNTRIES`, so a listing can no longer claim to
 * be in the UK — but that alone leaves a UK visitor free to browse, request,
 * and be given things, none of which the Online Safety Act cares about the
 * *listing's* country for. This middleware blocks the request itself, reads
 * and writes both, before it reaches any route.
 *
 * The signal is Cloudflare's own `request.cf.country` — populated by the
 * edge from the connection's IP geolocation before this Worker ever runs.
 * It is not a header, so nothing a client sends (a spoofed `CF-IPCountry`,
 * an `X-Forwarded-For`, anything) can set or override it; only Cloudflare's
 * edge writes it, the same way `CF-Connecting-IP` already can't be forged by
 * the client per `moderation/budget.ts`.
 */
import type { Context, Next } from "hono";
import type { Env } from "../env.js";

/**
 * One list, one name — so lifting the block later (a real risk assessment
 * done, or legal advice that changes the calculus) is a one-line change:
 * delete a code from this array. GB plus the three Crown Dependencies, which
 * share the UK's postal system and are the most likely to be swept up by a
 * UK-market-facing block like this even though the Online Safety Act itself
 * names Great Britain and Northern Ireland, not the Dependencies directly.
 */
export const UK_BLOCKED_COUNTRIES = ["GB", "JE", "GG", "IM"] as const;

export const UK_BLOCK_REASON =
  "Keepsake geo-blocks the UK (and the Crown Dependencies) for launch rather than take on " +
  "the UK Online Safety Act's base duties — a written illegal-content risk assessment, a " +
  "children's access assessment, a complaints procedure, and record-keeping — which carry no " +
  "small-service exemption. See docs/runbooks/uk-block.md.";

/** Paths a monitor or the platform itself hits, not a visitor — exempted so
 * an uptime check or the post-deploy `/version.json` comparison never trips
 * on wherever the checking machine happens to be. Neither serves anything a
 * UK visitor would use the product through. */
const EXEMPT_PATHS = new Set(["/health", "/version.json"]);

function countryOf(request: Request): string | undefined {
  // `Request.cf`'s ambient type is `IncomingRequestCfProperties |
  // RequestInitCfProperties` (the outbound-`fetch`-options shape too) —
  // accessing `.country` across that union collapses to `unknown` because
  // the second member's index signature has no `country` field of its own.
  // An inbound request handled by this Worker only ever carries the
  // Cloudflare-populated `IncomingRequestCfProperties` shape, never the
  // outbound-init one, so this narrows back to what's actually there.
  const cf = request.cf as IncomingRequestCfProperties | undefined;
  return cf?.country;
}

export function isUkBlockedCountry(country: string | undefined): boolean {
  if (!country) return false;
  return (UK_BLOCKED_COUNTRIES as readonly string[]).includes(country);
}

function explanationHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Not available in the UK yet — Keepsake</title>
  </head>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.5rem;line-height:1.5;color:#1a1a1a;">
    <h1 style="font-size:1.375rem;">Keepsake isn't available in the UK yet.</h1>
    <p>
      The UK's Online Safety Act asks every service like this one for a written safety
      assessment, a children's-access review, and a formal complaints process — real, ongoing
      work that Keepsake, a free project run by one person, hasn't taken on. Rather than offer
      the product without doing that work properly, we've turned it off for UK visitors for now.
    </p>
    <p>
      This isn't personal, and it isn't permanent by design — it's a deliberate choice to wait
      until it can be done right. If that changes, this page will too.
    </p>
    <p>Questions? Write to <a href="mailto:hello@keepsake.ing">hello@keepsake.ing</a>.</p>
  </body>
</html>`;
}

/**
 * Mounted once, early, in `src/index.ts` — before route dispatch, so it
 * covers `/api/*`, `/item/*`, the SPA shell, everything. 451 (Unavailable
 * For Legal Reasons) rather than a bare 403: it's the status code that
 * exists precisely to say "this isn't broken, and it isn't about you — it's
 * a legal/regulatory choice," which is exactly what this is.
 */
export function ukBlock() {
  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    if (EXEMPT_PATHS.has(c.req.path)) {
      await next();
      return;
    }

    const country = countryOf(c.req.raw);
    if (isUkBlockedCountry(country)) {
      return c.html(explanationHtml(), 451);
    }

    await next();
  };
}

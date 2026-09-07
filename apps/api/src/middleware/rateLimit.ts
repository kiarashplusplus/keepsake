/**
 * Two complementary layers, both described in `wrangler.toml`'s `[[ratelimits]]`
 * comment and `src/moderation/budget.ts`'s header:
 *
 * - `burst(...)` wraps a `[[ratelimits]]` binding (`RL_READ`, `RL_CREATE`, …):
 *   a short (10s/60s) per-minute **best-effort** burst brake at the edge,
 *   keyed by a digest of the caller's IP. "Best-effort" is load-bearing, not
 *   hedging (issue #8 / launch audit finding 10): Cloudflare's own docs for
 *   this binding call it "permissive, eventually consistent, and
 *   intentionally designed to not be used as an accurate accounting
 *   system" — counters are cached per-colo and reconciled asynchronously.
 *   Measured directly: `RL_UPLOAD` configured at 10/60s let 26 consecutive
 *   requests through before the first 429. That's Cloudflare's documented
 *   behavior working as designed, not a bug in how `.limit()` is called
 *   here — see `wrangler.toml`'s `[[ratelimits]]` comment for the full
 *   citation. Nothing security-critical may treat this number as exact;
 *   `dailyBudget(...)` below is the actual hard cap. Bindings are also
 *   absent in the vitest-pool-workers test runtime (miniflare has no local
 *   rate-limiting emulator), so this treats a missing binding as "allowed"
 *   rather than failing every test that exercises a write route — a second,
 *   unrelated reason this was never going to be the precise layer.
 * - `dailyBudget(...)` wraps the KV calendar-day counters in `budget.ts` for
 *   the five non-AI kinds this Worker rations: `listing`, `request`,
 *   `upload`, `report`, `email`. (`mod_text`/`mod_image` are checked inside the moderation
 *   pipeline itself, not as HTTP middleware, since that check happens in a
 *   background `waitUntil`, not on the request/response path.) Unlike
 *   `burst(...)`, this one *is* exact — a real KV read-then-write, per
 *   caller, per calendar day — so it's the layer anything security-critical
 *   should actually rely on.
 */
import type { Context, Next } from "hono";
import type { Env } from "../env.js";
import { fail } from "../lib/respond.js";
import { dailyIpDigest } from "../lib/digest.js";
import { checkAndBump, clientIPFrom, type BudgetKind } from "../moderation/budget.js";
import { parseIntVar } from "../env.js";

type RateLimitCtx = Context<{ Bindings: Env }>;

export type RateLimitBindingName =
  | "RL_READ"
  | "RL_WRITE"
  | "RL_UPLOAD"
  | "RL_CREATE"
  | "RL_REQUEST"
  | "RL_REPORT"
  | "RL_EMAIL"
  | "RL_ADMIN";

export function burst(bindingName: RateLimitBindingName) {
  return async (c: RateLimitCtx, next: Next) => {
    const binding = c.env[bindingName];
    if (!binding) {
      // No local emulator for `[[ratelimits]]` bindings — see header comment.
      await next();
      return;
    }

    // `dailyIpDigest`, not a bare `sha256Hex` of the address (issue #87).
    // This used to hash the address alone, which made the limiter key a
    // stable pseudonymous identifier for one caller with no expiry of its
    // own — the exact thing `apps/site/public/privacy.html`'s "Rate
    // limiting" section promises we don't keep, and the opposite of what
    // `budget.ts` had always done.
    //
    // The cost is one bucket boundary a day: at midnight UTC a caller's key
    // changes, so a 60s window straddling midnight is really two windows and
    // a determined caller gets up to twice the configured per-minute
    // allowance for that one minute. That is inside the noise this layer
    // already lives with — the binding is documented (above, and in
    // `wrangler.toml`) as best-effort and eventually consistent, and was
    // *measured* at ~2.6x overshoot on an ordinary minute — and the hard cap
    // behind it, `dailyBudget()`, resets at the same midnight anyway. A
    // once-a-day 2x on a brake that already leaks 2.6x is not worth a
    // never-rotating identifier for every caller.
    const key = await dailyIpDigest(clientIPFrom(c.req.raw));
    const { success } = await binding.limit({ key });
    if (!success) {
      return fail(c, "rate_limited", "Too many requests — please slow down.", 429, { retryAfter: 60 });
    }

    await next();
  };
}

/** The per-IP daily ceilings this middleware reads, all `[vars]` in
 * `wrangler.toml`. Kept as an explicit union (rather than `keyof Env`) so the
 * env lookup below stays a plain string, not a cast through Env's big
 * binding-and-var union type. */
export type IpDailyLimitVar =
  | "LISTING_IP_DAILY_BUDGET"
  | "REQUEST_IP_DAILY_BUDGET"
  | "UPLOAD_IP_DAILY_BUDGET"
  | "REPORT_IP_DAILY_BUDGET"
  | "EMAIL_IP_DAILY_BUDGET";

/** Per-IP daily ceiling for the `email` kind, shared by `POST /api/recover`
 * and `POST /api/me/email` (issue #92) — defined here rather than in either
 * route module because neither owns it, and two copies of a fallback is how
 * two routes end up rationing differently. Ten mails a day from one address
 * is far past a person recovering a dashboard or confirming an address, and
 * loose enough for a household or a CGNAT range doing the same thing a few
 * times over (see `moderation/budget.ts`'s header on why an address is not a
 * person). */
export const DEFAULT_EMAIL_IP_DAILY_BUDGET = 10;

export interface DailyBudgetOptions {
  kind: BudgetKind;
  ipDailyLimitVar: IpDailyLimitVar;
  fallbackIpDailyLimit: number;
}

/** Global ceilings for the kinds this middleware wraps aren't in
 * `wrangler.toml` — only the per-IP ones are, per the plan's `[vars]` list —
 * so the global side of `checkAndBump` is given a number far past what the
 * per-IP ceiling could ever reach, making the per-IP check the only one that
 * can actually fire for these kinds. A global ceiling here would be a way for
 * one caller to deny a feature to everyone (there is no account to ration
 * against), which is the opposite of what these are for; `mod_text`,
 * `mod_image` and `suggest` have real global ceilings because those spend a
 * shared Workers AI allocation. */
const EFFECTIVELY_UNLIMITED = 1_000_000;

export function dailyBudget(options: DailyBudgetOptions) {
  return async (c: RateLimitCtx, next: Next) => {
    const ipDailyLimit = parseIntVar(options.ipDailyLimitVar, c.env[options.ipDailyLimitVar], options.fallbackIpDailyLimit);
    const clientIP = clientIPFrom(c.req.raw);

    const result = await checkAndBump(c.env.KV, {
      kind: options.kind,
      clientIP,
      dailyLimit: EFFECTIVELY_UNLIMITED,
      ipDailyLimit,
    });

    if (!result.allowed) {
      return fail(c, "rate_limited", "Daily limit reached — please try again tomorrow.", 429, {
        ...(result.retryAfter !== undefined ? { retryAfter: result.retryAfter } : {}),
      });
    }

    await next();
  };
}

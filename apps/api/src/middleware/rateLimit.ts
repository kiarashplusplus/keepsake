/**
 * Two complementary layers, both described in `wrangler.toml`'s `[[ratelimits]]`
 * comment and `src/moderation/budget.ts`'s header:
 *
 * - `burst(...)` wraps a `[[ratelimits]]` binding (`RL_READ`, `RL_CREATE`, …):
 *   a short (10s/60s) per-minute burst brake at the edge, keyed by a digest
 *   of the caller's IP. Bindings are absent in the vitest-pool-workers test
 *   runtime (miniflare has no local rate-limiting emulator), so this treats a
 *   missing binding as "allowed" rather than failing every test that exercises
 *   a write route.
 * - `dailyBudget(...)` wraps the KV calendar-day counters in `budget.ts` for
 *   the three non-AI kinds this Worker rations: `listing`, `request`,
 *   `upload`. (`mod_text`/`mod_image` are checked inside the moderation
 *   pipeline itself, not as HTTP middleware, since that check happens in a
 *   background `waitUntil`, not on the request/response path.)
 */
import type { Context, Next } from "hono";
import type { Env } from "../env.js";
import { fail } from "../lib/respond.js";
import { sha256Hex } from "../lib/digest.js";
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

    const key = await sha256Hex(clientIPFrom(c.req.raw));
    const { success } = await binding.limit({ key });
    if (!success) {
      return fail(c, "rate_limited", "Too many requests — please slow down.", 429, { retryAfter: 60 });
    }

    await next();
  };
}

/** The three per-IP daily ceilings this middleware reads, all `[vars]` in
 * `wrangler.toml`. Kept as an explicit union (rather than `keyof Env`) so the
 * env lookup below stays a plain string, not a cast through Env's big
 * binding-and-var union type. */
export type IpDailyLimitVar = "LISTING_IP_DAILY_BUDGET" | "REQUEST_IP_DAILY_BUDGET" | "UPLOAD_IP_DAILY_BUDGET";

export interface DailyBudgetOptions {
  kind: BudgetKind;
  ipDailyLimitVar: IpDailyLimitVar;
  fallbackIpDailyLimit: number;
}

/** Global ceilings for `listing`/`request`/`upload` aren't in `wrangler.toml`
 * — only the per-IP ones are, per the plan's `[vars]` list — so the global
 * side of `checkAndBump` is given a number far past what the per-IP ceiling
 * could ever reach, making the per-IP check the only one that can actually
 * fire for these three kinds. */
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

/**
 * Cloudflare Turnstile verification for the write endpoints a stranger can
 * hit without an owner token (listing create, requests, reports, recover).
 *
 * `TURNSTILE_SECRET` is a Worker secret (see `.dev.vars.example`), not a
 * `[vars]` entry — it won't exist in local dev before `.dev.vars` is filled
 * in, nor on preview until the Turnstile widget is provisioned for the
 * domain (plan Risks). Rather than fail every write in the meantime, this
 * middleware passes through and logs once per isolate when the secret is
 * unset — a deliberate soft-fail for an unfinished piece of infrastructure,
 * not a security bug: once `TURNSTILE_SECRET` is set (preview/production),
 * verification is enforced unconditionally.
 */
import type { Context, Next } from "hono";
import type { Env } from "../env.js";
import { fail } from "../lib/respond.js";

type TurnstileCtx = Context<{ Bindings: Env }>;

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

let warnedMissingSecretOnce = false;

interface SiteverifyResponse {
  success: boolean;
  [key: string]: unknown;
}

export function turnstile() {
  // Named (not a bare arrow assigned nowhere) so `test/writeSurfaceTurnstile
  // .test.ts` (#246) can recognise this middleware by `handler.name` when it
  // walks the real app's registered route table — the guard has no other way
  // to tell "this route is Turnstile-mounted" from "it just happens to 403
  // sometimes" without either re-parsing source or naming the function.
  return async function turnstileMiddleware(c: TurnstileCtx, next: Next) {
    const secret = c.env.TURNSTILE_SECRET;
    if (!secret) {
      if (!warnedMissingSecretOnce) {
        console.warn(
          "turnstile: TURNSTILE_SECRET is unset — passing every request through unverified. " +
            "Expected in local dev/preview before the widget is provisioned; must be set before " +
            "production traffic relies on this middleware.",
        );
        warnedMissingSecretOnce = true;
      }
      await next();
      return;
    }

    const token = c.req.header("cf-turnstile-response");
    if (!token) {
      return fail(c, "turnstile_failed", "Please complete the verification and try again.", 403);
    }

    const body = new URLSearchParams({ secret, response: token });
    const clientIp = c.req.header("CF-Connecting-IP");
    if (clientIp) body.set("remoteip", clientIp);

    try {
      const verifyResponse = await fetch(SITEVERIFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      const result = (await verifyResponse.json()) as SiteverifyResponse;
      if (!result.success) {
        return fail(c, "turnstile_failed", "Verification failed, please try again.", 403);
      }
    } catch (err) {
      console.error("turnstile: siteverify request failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return fail(c, "turnstile_failed", "Verification failed, please try again.", 403);
    }

    await next();
  };
}

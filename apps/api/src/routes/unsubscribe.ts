/**
 * `GET`/`POST /api/unsubscribe/:token` and `POST /api/resubscribe/:token` —
 * the mechanism issue #310's first pass promised in the footer and left
 * unbuilt: "email hello@keepsake.ing and say so" with nothing reading that
 * inbox. See `src/email/unsubscribe.ts` for the token shape and
 * `docs/design/email.md`'s "CASL" section for the full argument.
 *
 * **Why GET never mutates.** Mail clients, link scanners, and corporate
 * security proxies fetch URLs out of messages before a human ever sees
 * them — the same reasoning `requestConfirm.ts`'s header gives for
 * `POST`-only confirmation. `GET` here is read-only status, safe for a
 * scanner to prefetch: it answers "is this token currently suppressed" so
 * `apps/web/app/unsubscribe/[token].tsx` can state the consequence
 * *before* showing a button, but it changes nothing.
 *
 * **Why POST here is safe to be one-click**, unlike `requestConfirm.ts`'s
 * POST-from-a-page-only stance: RFC 8058 (`List-Unsubscribe-Post`) exists
 * precisely so a mail client's own "Unsubscribe" affordance can hit this
 * URL directly with no page in between, and that in-client affordance
 * *is* the confirmation — a user chose it deliberately, the same way
 * clicking "Report spam" is deliberate. The web page's button also POSTs
 * here, but only after showing the consequence text; a bare GET on that
 * page never does (`suppressionStatusForToken` above).
 *
 * **No Turnstile, no burst limiter, no auth** — same shape as
 * `requestConfirm.ts`/`requestWithdraw.ts`/`recover.ts`'s `/exchange`: the
 * token itself is the credential (a keyed HMAC nobody can forge without
 * `UNSUBSCRIBE_SECRET`), and every effect this route has is one row,
 * idempotent to replay. See `test/writeSurfaceTurnstile.test.ts`'s
 * allowlist entries for these two routes for the write-up.
 */
import { Hono } from "hono";
import { UnsubscribeStatusResult } from "@keepsake/contracts/email";
import type { Env } from "../env.js";
import { ok, fail } from "../lib/respond.js";
import { setSuppression, suppressionStatusForToken } from "../email/unsubscribe.js";

export const unsubscribeRoutes = new Hono<{ Bindings: Env }>();
export const resubscribeRoutes = new Hono<{ Bindings: Env }>();

/** A token that is obviously not one of ours (empty, absurdly long) is
 * refused before it ever reaches D1 — not for security (a wrong-shaped
 * token is just a lookup miss either way) but so a malformed link doesn't
 * spend a query on something that can never match. */
function isPlausibleToken(token: string): boolean {
  return token.length > 0 && token.length <= 128;
}

unsubscribeRoutes.get("/:token", async (c) => {
  const token = c.req.param("token");
  if (!isPlausibleToken(token)) return fail(c, "not_found", "This link is invalid.", 404);
  const status = await suppressionStatusForToken(c.env, token);
  return ok(c, UnsubscribeStatusResult.parse(status));
});

unsubscribeRoutes.post("/:token", async (c) => {
  const token = c.req.param("token");
  if (!isPlausibleToken(token)) return fail(c, "not_found", "This link is invalid.", 404);
  await setSuppression(c.env, token, true);
  return ok(c, UnsubscribeStatusResult.parse({ unsubscribed: true }));
});

resubscribeRoutes.post("/:token", async (c) => {
  const token = c.req.param("token");
  if (!isPlausibleToken(token)) return fail(c, "not_found", "This link is invalid.", 404);
  await setSuppression(c.env, token, false);
  return ok(c, UnsubscribeStatusResult.parse({ unsubscribed: false }));
});

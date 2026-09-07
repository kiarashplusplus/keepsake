/**
 * `POST /api/recover` / `POST /api/recover/exchange` — dashboard recovery for
 * an owner who kept a verified email, per docs/design/identity.md. Losing
 * the device without a verified email is unrecoverable by design; this is
 * the only way back for the ones who did add one.
 */
import { Hono } from "hono";
import { RecoverExchangeInput, RecoverInput, OWNER_TOKEN_PREFIX, type RecoverResult } from "@keepsake/contracts/owner";
import type { Env } from "../env.js";
import { ok, fail } from "../lib/respond.js";
import { ulid } from "../lib/ids.js";
import { sha256Hex } from "../lib/digest.js";
import { randomTokenRaw } from "../lib/tokens.js";
import { turnstile } from "../middleware/turnstile.js";
import { burst, dailyBudget, DEFAULT_EMAIL_IP_DAILY_BUDGET } from "../middleware/rateLimit.js";
import { validateBody } from "../middleware/validate.js";
import { sendMail } from "../email/sendMail.js";
import { recover as recoverTemplate } from "../email/templates/recover.js";

type Vars = { validatedBody: RecoverInput | RecoverExchangeInput };
export const recoverRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

/** Short-lived on purpose: this token is only useful for the stretch between
 * requesting it and clicking the emailed link. Exported because the recovery
 * email states this lifetime to the reader in words — it is handed to the
 * template rather than restated there, and `test/email.test.ts` holds the
 * two together.
 *
 * Raised from 30 to 60 minutes on 2026-09-07 (Kiarash's call). The clock
 * starts when `sendMail` returns, not when the mail lands, and everything
 * between those two moments is someone else's: greylisting alone routinely
 * costs 15 minutes on a first send from a young domain, and this domain is
 * young. Half an hour of that budget spent in a queue leaves a person
 * clicking a dead link through no fault of their own, on the one path that
 * exists *because* they already lost access. The extra half hour costs
 * little: the token is single-use, hashed at rest, and exchanging it rotates
 * the owner token immediately, so a stolen mailbox's window widens by 30
 * minutes on an attack that already requires the mailbox. Delivery outside
 * Kiarash's own address has still never been observed arriving (#6), which
 * is the other reason not to be tight here — the failure it would produce is
 * indistinguishable from the one #6 describes. */
export const RECOVER_TTL_MS = 60 * 60 * 1000;

// Issue #92: this route puts a real message in a real inbox, and until now
// the only thing in front of it was the best-effort burst brake (~2.6x
// leakage measured, #8) — no hard ceiling at all on how much mail one
// address could cause in a day. The `email` budget kind is shared with
// `POST /api/me/email` on purpose: what's rationed is outbound mail, not the
// path it was asked for, so alternating between the two routes doesn't buy a
// second allowance. Budget after `turnstile()`, so a failed challenge doesn't
// spend a real person's recovery attempts. Same caveat as the report route's
// ceiling: it is per address, so a caller with a range of them still gets a
// fresh allowance per address — see that comment for why the alternatives
// cost more than they're worth today.
recoverRoutes.post(
  "/",
  turnstile(),
  burst("RL_EMAIL"),
  dailyBudget({ kind: "email", ipDailyLimitVar: "EMAIL_IP_DAILY_BUDGET", fallbackIpDailyLimit: DEFAULT_EMAIL_IP_DAILY_BUDGET }),
  validateBody(RecoverInput),
  async (c) => {
    const input = c.get("validatedBody") as RecoverInput;

    const owner = await c.env.DB.prepare("SELECT id FROM owners WHERE email = ? AND email_verified_at IS NOT NULL")
      .bind(input.email)
      .first<{ id: string }>();

    // Always 200 regardless of a match — an error/different response for an
    // unknown or unverified address would let a caller enumerate which
    // addresses have a Keepsake dashboard behind them.
    if (owner) {
      const now = Date.now();
      const rawToken = randomTokenRaw();
      const tokenHash = await sha256Hex(rawToken);
      await c.env.DB.prepare(
        `INSERT INTO recovery_tokens (id, owner_id, purpose, token_hash, expires_at, created_at)
         VALUES (?, ?, 'recover', ?, ?, ?)`,
      )
        .bind(ulid(), owner.id, tokenHash, now + RECOVER_TTL_MS, now)
        .run();

      const link = `${c.env.SITE_URL}/recover/${rawToken}`;
      await sendMail(c.env, { kind: "recover", to: input.email, ...recoverTemplate({ link, ttlMs: RECOVER_TTL_MS }) });
    }

    return ok(c, { sent: true });
  },
);

/**
 * Issue #182: this used to be `POST /api/recover/:token`, with a live
 * account-takeover credential sitting in the URL. `apps/api/src/index.ts`'s
 * `onError` logs the request path, and Workers Logs keeps every line
 * (`head_sampling_rate = 1` in all three env blocks) — so any request that
 * threw while a giver was clicking their emailed link wrote the token
 * verbatim into a log store, still live, still single-use-but-unused. The
 * redactor knew `?token=` and `Bearer …` and nothing about a secret sitting
 * in a path segment.
 *
 * It takes `{ token }` in the JSON body now, exactly as
 * `POST /api/requests/withdraw` already did for a strictly lower-value
 * token (`src/routes/requestWithdraw.ts`) — one flow copying the other,
 * rather than two shapes for the same kind of secret. The path-segment form
 * is gone rather than kept as an alias: leaving it registered would leave
 * the leak reachable by anyone still holding an old link, and the emailed
 * link is a *web* route (`/recover/<token>`, read by `apps/web/app/recover/
 * [token].tsx`), so old mail keeps working — that page reads the token out
 * of its own path and posts it here in a body.
 *
 * No Turnstile, unchanged: possession of the mailed token is the proof.
 */
recoverRoutes.post("/exchange", validateBody(RecoverExchangeInput), async (c) => {
  const { token } = c.get("validatedBody") as RecoverExchangeInput;
  const tokenHash = await sha256Hex(token);
  const now = Date.now();

  const row = await c.env.DB.prepare(
    `SELECT id, owner_id, expires_at, used_at FROM recovery_tokens WHERE token_hash = ? AND purpose = 'recover'`,
  )
    .bind(tokenHash)
    .first<{ id: string; owner_id: string; expires_at: number; used_at: number | null }>();

  if (!row || row.used_at !== null || row.expires_at < now) {
    return fail(c, "unauthorized", "This recovery link is invalid or has expired.", 401);
  }

  const newRawToken = `${OWNER_TOKEN_PREFIX}${randomTokenRaw()}`;
  const newTokenHash = await sha256Hex(newRawToken);

  // The old token is dead the instant this lands — a device that loses the
  // recovery race gets 401 on its very next request, by design (compromise
  // containment, not a bug to smooth over: see docs/design/identity.md).
  await c.env.DB.prepare("UPDATE owners SET token_hash = ? WHERE id = ?").bind(newTokenHash, row.owner_id).run();
  await c.env.DB.prepare("UPDATE recovery_tokens SET used_at = ? WHERE id = ?").bind(now, row.id).run();

  const result: RecoverResult = { ownerToken: newRawToken };
  return ok(c, result);
});

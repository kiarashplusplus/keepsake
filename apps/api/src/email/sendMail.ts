/**
 * `sendMail(env, message)` — the one call site every notification email goes
 * through (verify, new request, request received, chosen, recover, admin
 * test). Two providers behind the same interface, selected by
 * `EMAIL_PROVIDER`:
 *
 *  - `cf`: `env.EMAIL.send(...)` (the `[[send_email]]` binding).
 *  - `resend`: `POST https://api.resend.com/emails` with `RESEND_API_KEY`.
 *
 * Cloudflare Email Service account enablement and the `keepsake.ing` sender
 * onboarding are unverified (plan Risk #1) — a missing binding/key, an
 * unrecognized provider value, or the send itself throwing all fall through
 * to a `[email:stub]` log rather than throwing. A give/request/choose flow
 * must never break because notification email isn't wired up yet; the
 * caller gets `{ sent: false, reason }` back to act on if it cares (nothing
 * currently does — every call site fires-and-forgets this).
 *
 * Every attempt, successful or not, is recorded in `email_events`
 * (`0004_email_events.sql`) keyed by `sha256(lowercased address)` — never
 * the raw address — so "did this actually send" is answerable from the DB.
 */
import { isReservedEmailDomain } from "@keepsake/contracts/common";
import type { Env } from "../env.js";
import { emailProviderName } from "../env.js";
import { sha256Hex } from "../lib/digest.js";
import { ulid } from "../lib/ids.js";

/**
 * Recipient guard — the reason Keepsake cannot spray bounces at its own
 * sending reputation.
 *
 * Cloudflare scores a sending domain on bounce rate (safe under 2%, at risk
 * at 5%). At our volume that is one or two bad addresses, and the repo is
 * full of `someone@example.com` fixtures: 80 of them across the API, web and
 * contract tests. Those run against a fake binding today, but "today" is not
 * a safety property. This runs on every send, in every environment, and is
 * the only thing standing between a stray test run and a burned domain.
 *
 * Two layers:
 *
 * 1. **Reserved domains are refused everywhere, production included.**
 *    RFC 2606 / RFC 6761 set aside `example.com|net|org` and the `.test`,
 *    `.invalid`, `.localhost` and `.local` suffixes precisely so they can
 *    never resolve. Mail to them is guaranteed to bounce, so there is no
 *    environment where sending is the right behaviour.
 *
 * 2. **Outside production, an allowlist.** `EMAIL_MODE=allowlist` sends only
 *    to addresses in `EMAIL_ALLOWLIST`; everything else is recorded and
 *    dropped. Preview talks to the same verified domain as production, so
 *    without this a preview smoke test would mail a real stranger who typed
 *    their address into a listing request.
 *
 * Fails closed: an unset or unrecognised `EMAIL_MODE` sends nothing.
 * Blocked attempts are still written to `email_events` (`ok = 0`) so a
 * silently-dropped notification is visible rather than mysterious.
 *
 * The reserved-domain list itself lives in `@keepsake/contracts/common`
 * (`isReservedEmailDomain`) so the web form that first sees the address and
 * this last-line-of-defence check can never drift apart.
 */
export type GuardDecision = { allowed: true } | { allowed: false; reason: string };

/** Reserved-by-standard domains that can never accept mail. */
export const isReservedDomain = isReservedEmailDomain;

function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

export function guardRecipient(env: Env, to: string): GuardDecision {
  const address = to.trim().toLowerCase();
  const mode = (env.EMAIL_MODE ?? "").trim().toLowerCase();

  // "test" short-circuits everything, including the reserved-domain rule,
  // because the unit suite is built on `@example.com` fixtures and sends them
  // through a fake binding where nothing leaves the process. It is safe only
  // because it can never be set outside vitest: `email-mode-config.test.ts`
  // reads wrangler.toml and fails if this value ever appears there.
  if (mode === "test") return { allowed: true };

  if (address.length === 0 || !address.includes("@")) {
    return { allowed: false, reason: "blocked_invalid_address" };
  }
  if (isReservedDomain(address)) {
    return { allowed: false, reason: "blocked_reserved_domain" };
  }

  if (mode === "live") return { allowed: true };
  if (mode === "allowlist") {
    const allowed = parseAllowlist(env.EMAIL_ALLOWLIST);
    if (allowed.includes(address)) return { allowed: true };
    return { allowed: false, reason: "blocked_not_allowlisted" };
  }
  return { allowed: false, reason: "blocked_email_mode_off" };
}

export type EmailKind = "verify_email" | "new_request" | "request_received" | "chosen" | "recover" | "admin_test";

export interface MailMessage {
  kind: EmailKind;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export interface SendMailResult {
  sent: boolean;
  reason?: string;
}

async function recordEmailEvent(
  env: Env,
  fields: { kind: EmailKind; toHash: string; provider: string; ok: boolean; error?: string },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO email_events (id, kind, to_hash, provider, ok, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(ulid(), fields.kind, fields.toHash, fields.provider, fields.ok ? 1 : 0, fields.error ?? null, Date.now())
    .run();
}

async function sendViaCloudflare(env: Env, message: MailMessage): Promise<SendMailResult> {
  try {
    await env.EMAIL.send({
      from: env.EMAIL_FROM,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      ...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}),
    });
    return { sent: true };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error("sendMail: EMAIL.send failed", { error: errorMessage });
    // Keep the provider's words: "send_failed" alone told us nothing when the
    // sender domain was not yet onboarded.
    return { sent: false, reason: `send_failed: ${errorMessage.slice(0, 160)}` };
  }
}

async function sendViaResend(env: Env, message: MailMessage): Promise<SendMailResult> {
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.replyTo !== undefined ? { reply_to: message.replyTo } : {}),
      }),
    });
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 120);
      console.error("sendMail: resend request failed", { status: response.status, body });
      return { sent: false, reason: `send_failed: resend ${response.status} ${body}` };
    }
    return { sent: true };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error("sendMail: resend request threw", { error: errorMessage });
    return { sent: false, reason: `send_failed: ${errorMessage.slice(0, 160)}` };
  }
}

export async function sendMail(env: Env, message: MailMessage): Promise<SendMailResult> {
  const toHash = await sha256Hex(message.to.toLowerCase());
  const provider = emailProviderName(env);

  let result: SendMailResult;
  let providerLabel: string;

  const guard = guardRecipient(env, message.to);
  if (!guard.allowed) {
    // Recorded, not thrown: the give/request/choose flow it belongs to must
    // still succeed, and `email_events` is where "why did nothing arrive"
    // gets answered.
    console.log("[email:blocked]", { subject: message.subject, reason: guard.reason });
    await recordEmailEvent(env, {
      kind: message.kind,
      toHash,
      provider: "blocked",
      ok: false,
      error: guard.reason,
    });
    return { sent: false, reason: guard.reason };
  }

  if (provider === "cf" && env.EMAIL) {
    providerLabel = "cf";
    result = await sendViaCloudflare(env, message);
  } else if (provider === "resend" && env.RESEND_API_KEY) {
    providerLabel = "resend";
    result = await sendViaResend(env, message);
  } else {
    providerLabel = "none";
    const reason = provider === "cf" ? "email_binding_missing" : provider === "resend" ? "resend_key_missing" : "provider_unset";
    console.log("[email:stub]", { to: message.to, subject: message.subject, reason });
    result = { sent: false, reason };
  }

  await recordEmailEvent(env, {
    kind: message.kind,
    toHash,
    provider: providerLabel,
    ok: result.sent,
    ...(result.reason !== undefined ? { error: result.reason } : {}),
  });

  return result;
}

/**
 * `sendMail(env, message)` — the one call site every notification email goes
 * through (verify, new request, chosen, recover). Two providers behind the
 * same interface, selected by `EMAIL_PROVIDER`:
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
import type { Env } from "../env.js";
import { emailProviderName } from "../env.js";
import { sha256Hex } from "../lib/digest.js";
import { ulid } from "../lib/ids.js";

export type EmailKind = "verify_email" | "new_request" | "chosen" | "recover";

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

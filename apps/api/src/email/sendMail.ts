/**
 * M1 stub, per `docs/design/email.md`'s M3 plan: real templates and the
 * Resend fallback provider land in M3. Today, `EMAIL_PROVIDER=cf` with the
 * `EMAIL` binding present sends through Cloudflare's Email Service
 * (`SendEmail.send()` accepts this plain object shape directly — no raw MIME
 * construction needed); anything else — provider not `cf`, binding missing
 * (sender domain onboarding unverified, plan Risk #1), or the send throwing —
 * logs `[email:stub]` instead of failing the caller's request. A give flow
 * must never break because notification email isn't wired up yet.
 */
import type { Env } from "../env.js";

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export async function sendMail(env: Env, message: MailMessage): Promise<void> {
  if (env.EMAIL_PROVIDER === "cf" && env.EMAIL) {
    try {
      await env.EMAIL.send({
        from: env.EMAIL_FROM,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}),
      });
      return;
    } catch (err) {
      console.error("sendMail: EMAIL.send failed, falling back to stub log", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log("[email:stub]", { to: message.to, subject: message.subject });
}

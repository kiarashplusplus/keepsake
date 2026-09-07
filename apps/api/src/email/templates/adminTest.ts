import { renderShell, footerLine, sanitizeSubject, type EmailTemplate } from "./shared.js";

/**
 * `POST /api/admin/test-email` — a real message through the real
 * `sendMail()` path, on demand, so delivery is verifiable at any time
 * instead of inferred from "no one's complained yet." Launch-audit finding:
 * production email had never delivered to anyone but Kiarash, and every
 * failure was swallowed silently.
 */
export function adminTest(now: Date = new Date()): EmailTemplate {
  const reason = "you're getting this because someone with the Keepsake admin token asked for a test send.";
  const stamp = now.toISOString();

  return {
    subject: sanitizeSubject(`Keepsake test email — ${stamp}`),
    html: renderShell({
      bodyHtml: `<p>This is a test message sent from <code>POST /api/admin/test-email</code> at ${stamp}.</p>
        <p>If you're reading this, delivery works right now, through whichever provider is configured
        (<code>EMAIL_PROVIDER</code>) in this environment.</p>`,
      footerReason: reason,
    }),
    text: `This is a test message sent from POST /api/admin/test-email at ${stamp}.\n\nIf you're reading this, delivery works right now, through whichever provider is configured (EMAIL_PROVIDER) in this environment.\n\n${footerLine(reason)}`,
  };
}

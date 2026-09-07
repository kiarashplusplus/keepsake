import { renderButton, renderShell, plainLinkLine, footerLine, sanitizeSubject, type EmailTemplate } from "./shared.js";

export interface RecoverParams {
  link: string;
  /** The token's real lifetime, from `RECOVER_TTL_MS` in
   * `src/routes/recover.ts` — the same value written into the row's
   * `expires_at`. Passed in rather than restated here because the sentence
   * below is a promise to a reader about when their link stops working, and
   * a promise in prose beside a number in code is the drift
   * `apps/web/test/guards/privacyPolicy.test.ts` exists to catch. Shortening
   * the TTL used to leave this email telling people 30 minutes regardless. */
  ttlMs: number;
}

/** "30 minutes" / "1 minute" — the email says what the token does, in the
 * units a person reading it thinks in. Rounds rather than flooring so a TTL
 * that is not a whole number of minutes never understates the wait. */
function describeMinutes(ttlMs: number): string {
  const minutes = Math.max(1, Math.round(ttlMs / 60_000));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** Sent from `POST /api/recover` — only ever to a verified owner email
 * (the route itself always returns 200 regardless of a match, so this
 * template's existence or absence never leaks that fact). Expiry is stated
 * plainly since a stale link failing silently is a worse experience than a
 * clear "get a new one". */
export function recover(params: RecoverParams): EmailTemplate {
  const reason = "you're getting this because someone asked to recover a Keepsake dashboard with this address.";
  const intro = `Use this link to get back into your Keepsake dashboard. It works once, and expires in ${describeMinutes(params.ttlMs)}.`;

  return {
    subject: sanitizeSubject("Recover your Keepsake dashboard"),
    html: renderShell({
      bodyHtml: `<p>${intro}</p>${renderButton(params.link, "Recover dashboard")}${plainLinkLine(params.link)}<p style="font-size:13px;color:#7A7168;">Didn't ask for this? You can ignore this email.</p>`,
      footerReason: reason,
    }),
    text: `${intro}\n\n${params.link}\n\nDidn't ask for this? You can ignore this email.\n\n${footerLine(reason)}`,
  };
}

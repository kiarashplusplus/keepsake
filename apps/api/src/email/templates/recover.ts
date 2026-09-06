import { renderButton, renderShell, plainLinkLine, footerLine, type EmailTemplate } from "./shared.js";

export interface RecoverParams {
  link: string;
}

/** Sent from `POST /api/recover` — only ever to a verified owner email
 * (the route itself always returns 200 regardless of a match, so this
 * template's existence or absence never leaks that fact). Expiry is stated
 * plainly since a stale link failing silently is a worse experience than a
 * clear "get a new one". */
export function recover(params: RecoverParams): EmailTemplate {
  const reason = "you're getting this because someone asked to recover a Keepsake dashboard with this address.";
  const intro = "Use this link to get back into your Keepsake dashboard. It works once, and expires in 30 minutes.";

  return {
    subject: "Recover your Keepsake dashboard",
    html: renderShell({
      bodyHtml: `<p>${intro}</p>${renderButton(params.link, "Recover dashboard")}${plainLinkLine(params.link)}<p style="font-size:13px;color:#7A7168;">Didn't ask for this? You can ignore this email.</p>`,
      footerReason: reason,
    }),
    text: `${intro}\n\n${params.link}\n\nDidn't ask for this? You can ignore this email.\n\n${footerLine(reason)}`,
  };
}

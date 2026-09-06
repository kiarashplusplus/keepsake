import { colorsLight } from "@keepsake/tokens/colors";
import { renderButton, renderShell, footerLine, escapeHtml, type EmailTemplate } from "./shared.js";

export interface NewRequestParams {
  listingTitle: string;
  note: string;
  dashboardLink: string;
}

/** Sent to a verified giver from `POST /api/listings/:id/requests` — the
 * requester's contact stays masked here and everywhere else until the giver
 * chooses them (docs/design/email.md's "contact reveal rule"), so this only
 * ever quotes the note itself. */
export function newRequest(params: NewRequestParams): EmailTemplate {
  const reason = "you're getting this because someone asked about a keepsake you posted.";
  const title = escapeHtml(params.listingTitle);
  const note = escapeHtml(params.note);

  return {
    subject: `Someone would love "${params.listingTitle}"`,
    html: renderShell({
      bodyHtml: `<p>Someone would love your keepsake, <em>${title}</em>.</p>
        <blockquote style="margin:16px 0;padding:12px 16px;border-left:3px solid ${colorsLight.accent};background:${colorsLight.surfaceSunken};font-style:italic;color:${colorsLight.ink};">${note}</blockquote>
        <p>No rush — choose whenever you're ready.</p>
        ${renderButton(params.dashboardLink, "View request")}`,
      footerReason: reason,
    }),
    text: `Someone would love your keepsake, "${params.listingTitle}".\n\n"${params.note}"\n\nNo rush — choose whenever you're ready.\n\n${params.dashboardLink}\n\n${footerLine(reason)}`,
  };
}

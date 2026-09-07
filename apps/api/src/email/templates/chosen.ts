import { colorsLight } from "@keepsake/tokens/colors";
import { renderButton, renderShell, footerLine, escapeHtml, sanitizeSubject, type EmailTemplate } from "./shared.js";

export interface ChosenParams {
  listingTitle: string;
  /** Only given when the giver has a verified email — this is also the
   * address `src/routes/me.ts`'s choose handler sets as `replyTo` on the
   * message itself, so this template's copy and the header agree. */
  giverEmail?: string;
  handoffNote: string;
  itemLink: string;
}

/** Sent to the chosen requester from `POST /api/me/listings/:id/choose` —
 * the one moment both parties' contact becomes mutually visible
 * (docs/design/email.md). */
export function chosen(params: ChosenParams): EmailTemplate {
  const reason = "you're getting this because you asked for a keepsake and were chosen.";
  const title = escapeHtml(params.listingTitle);
  const note = escapeHtml(params.handoffNote);
  const contactHtml = params.giverEmail
    ? `<p>You can reach them directly at <a href="mailto:${escapeHtml(params.giverEmail)}" style="color:${colorsLight.accentText};">${escapeHtml(params.giverEmail)}</a>, or just reply to this email.</p>`
    : `<p>Reply to this email to reach them directly.</p>`;
  const contactText = params.giverEmail
    ? `You can reach them directly at ${params.giverEmail}, or just reply to this email.`
    : "Reply to this email to reach them directly.";

  return {
    subject: sanitizeSubject(`You were chosen for "${params.listingTitle}"`),
    html: renderShell({
      bodyHtml: `<p>Good news — you were chosen for <em>${title}</em>.</p>
        <blockquote style="margin:16px 0;padding:12px 16px;border-left:3px solid ${colorsLight.accent};background:${colorsLight.surfaceSunken};font-style:italic;color:${colorsLight.ink};">${note}</blockquote>
        ${contactHtml}
        ${renderButton(params.itemLink, "View the keepsake")}`,
      footerReason: reason,
    }),
    text: `Good news — you were chosen for "${params.listingTitle}".\n\n"${params.handoffNote}"\n\n${contactText}\n\n${params.itemLink}\n\n${footerLine(reason)}`,
  };
}

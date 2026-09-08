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
  // The no-address branch must not say "reply to this email". `replyTo` is
  // set by `routes/me.ts`'s choose handler *only* when the giver's address is
  // verified — exactly the case this branch is not — so a reply here goes to
  // `hello@keepsake.ing`, which the zone's catch-all forwards to a personal
  // inbox (`docs/design/email.md`, "Inbound"). The requester would be writing
  // to Keepsake believing they were writing to the giver, and the giver would
  // never hear about it. Say what is actually true instead: they have your
  // note and your address, and the next move is theirs.
  const contactHtml = params.giverEmail
    ? `<p>You can reach them directly at <a href="mailto:${escapeHtml(params.giverEmail)}" style="color:${colorsLight.accentText};">${escapeHtml(params.giverEmail)}</a>, or just reply to this email.</p>`
    : `<p>They have your note and your contact details, and will be in touch to arrange the handover.</p>`;
  const contactText = params.giverEmail
    ? `You can reach them directly at ${params.giverEmail}, or just reply to this email.`
    : "They have your note and your contact details, and will be in touch to arrange the handover.";

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

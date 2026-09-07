import { colorsLight } from "@keepsake/tokens/colors";
import { renderShell, plainLinkLine, footerLine, escapeHtml, type EmailTemplate } from "./shared.js";

export interface RequestReceivedParams {
  listingTitle: string;
  withdrawLink: string;
}

/**
 * Sent to the *requester* from `POST /api/listings/:id/requests` — the one
 * confirmation this flow was missing (docs/legal-considerations.md "Deleting
 * your information"): until this template existed, someone who asked for a
 * keepsake had no record of having done so and no way back in to remove
 * their note/email/phone, since they never get an account.
 *
 * `withdrawLink` carries the single-use token `POST /api/requests/withdraw`
 * consumes (`src/routes/requestWithdraw.ts`) — the whole reason this email
 * exists rather than being folded into a generic "thanks" message.
 */
export function requestReceived(params: RequestReceivedParams): EmailTemplate {
  const reason = "you're getting this because you asked for a keepsake on Keepsake.";
  const title = escapeHtml(params.listingTitle);

  return {
    subject: `We passed your note along for "${params.listingTitle}"`,
    html: renderShell({
      bodyHtml: `<p>We let the giver of <em>${title}</em> know you're interested. There's nothing more to
        do — if they choose you, you'll hear from them directly at this address.</p>
        <p style="color:${colorsLight.textSecondary};font-size:14px;">Changed your mind, or didn't mean to send this?
        <a href="${params.withdrawLink}" style="color:${colorsLight.accentText};">Withdraw your request</a> and we'll remove
        your note, email, and phone number from our records. (If the giver already chose you and this email already
        reached them, we can't unsend that — withdrawing only removes what's still in our database.)</p>
        ${plainLinkLine(params.withdrawLink)}`,
      footerReason: reason,
    }),
    text: `We let the giver of "${params.listingTitle}" know you're interested. There's nothing more to do — if they choose you, you'll hear from them directly at this address.\n\nChanged your mind, or didn't mean to send this? Withdraw your request and we'll remove your note, email, and phone number from our records. (If the giver already chose you and this email already reached them, we can't unsend that — withdrawing only removes what's still in our database.)\n\n${params.withdrawLink}\n\n${footerLine(reason)}`,
  };
}

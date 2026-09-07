import { colorsLight } from "@keepsake/tokens/colors";
import { renderShell, renderButton, plainLinkLine, footerLine, escapeHtml, sanitizeSubject, type EmailTemplate } from "./shared.js";

export interface ConfirmRequestParams {
  listingTitle: string;
  confirmLink: string;
}

/**
 * Issue #188. The *only* message that goes to an address before anyone has
 * proved they control it, and the single reason this flow is safe to expose
 * to strangers at all: until this link is clicked nothing has been forwarded
 * to the giver, nothing counts toward the listing's `request_count`, and the
 * held row is deleted unread when the link expires.
 *
 * Two properties of this copy are load-bearing, not stylistic:
 *
 * 1. **It never echoes the requester's note.** The note is free text supplied
 *    by whoever posted the form, and this message goes to an address that
 *    person may have picked at random. Reflecting it would turn a safety
 *    mechanism into a delivery channel for anonymous text aimed at a
 *    stranger's inbox — the harassment vector the confirmation step exists to
 *    close, rebuilt inside the confirmation itself. Only `listingTitle` is
 *    interpolated, and that is public, already-moderated listing content.
 * 2. **Doing nothing is a complete answer.** Someone who didn't send this has
 *    no account to secure, nothing to click and nobody to write to; saying so
 *    plainly is what keeps an unwanted message from also being an alarming
 *    one. The address is erased on its own when the link lapses, and the copy
 *    promises exactly that and nothing more.
 */
export function confirmRequest(params: ConfirmRequestParams): EmailTemplate {
  const reason = "you're getting this because this address was used to ask for a keepsake on Keepsake.";
  const title = escapeHtml(params.listingTitle);
  const intro = `Someone used this address to ask for <em>${title}</em>. If that was you, confirm it and we'll pass your note to the giver — we haven't shown it to anyone yet.`;
  const introText = `Someone used this address to ask for "${params.listingTitle}". If that was you, confirm it and we'll pass your note to the giver — we haven't shown it to anyone yet.`;
  const notYou =
    "If it wasn't you, there's nothing to do. Ignore this and the request is never sent; we'll delete the address and the note on their own within a few days.";

  return {
    subject: sanitizeSubject(`Did you ask for "${params.listingTitle}"?`),
    html: renderShell({
      bodyHtml: `<p>${intro}</p>${renderButton(params.confirmLink, "Yes, send my request")}${plainLinkLine(params.confirmLink)}
        <p style="color:${colorsLight.textSecondary};font-size:14px;">${notYou}</p>`,
      footerReason: reason,
    }),
    text: `${introText}\n\n${params.confirmLink}\n\n${notYou}\n\n${footerLine(reason)}`,
  };
}

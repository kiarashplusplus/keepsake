import { renderButton, renderShell, plainLinkLine, footerLine, type EmailTemplate } from "./shared.js";

export interface VerifyEmailParams {
  link: string;
}

/** Sent from `POST /api/me/email` (and reused by `POST /api/listings` when
 * an email is given at create time) — confirms the address before it's
 * trusted for notifications or recovery. */
export function verifyEmail(params: VerifyEmailParams): EmailTemplate {
  const reason = "you're getting this because you added this address to a keepsake listing.";
  const intro = "One click and you're set. We'll let you know when someone asks about your keepsake, and this address is how you'd find your listings again if you switch devices.";

  return {
    subject: "Confirm your email — Keepsake",
    html: renderShell({
      bodyHtml: `<p>${intro}</p>${renderButton(params.link, "Confirm email")}${plainLinkLine(params.link)}`,
      footerReason: reason,
    }),
    text: `${intro}\n\n${params.link}\n\n${footerLine(reason)}`,
  };
}

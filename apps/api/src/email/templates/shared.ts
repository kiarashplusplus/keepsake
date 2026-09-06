/**
 * Shared HTML shell for every transactional email, styled with
 * `@keepsake/tokens/colors`' light palette (never dark — email clients don't
 * reliably honor `prefers-color-scheme`, and a fixed light background reads
 * correctly everywhere) so the "warm keepsake box" feel survives outside the
 * app. Table-based layout and inline styles throughout: this has to render
 * in Outlook and Gmail's clipped CSS sandbox, not just a browser.
 */
import { colorsLight } from "@keepsake/tokens/colors";

export interface EmailTemplate {
  subject: string;
  text: string;
  html: string;
}

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderButton(href: string, label: string): string {
  return `<p style="text-align:center;margin:28px 0;">
    <a href="${href}" style="display:inline-block;background:${colorsLight.accent};color:${colorsLight.onAccent};text-decoration:none;padding:12px 28px;border-radius:8px;font-family:${SANS};font-size:15px;font-weight:600;">${escapeHtml(label)}</a>
  </p>`;
}

/** The plain-text link line every template repeats under its button, for
 * clients that strip `<a>` styling or images entirely. */
export function plainLinkLine(link: string): string {
  return `<p style="font-size:13px;color:${colorsLight.textSecondary};word-break:break-all;">Or paste this link into your browser: ${escapeHtml(link)}</p>`;
}

export function renderShell(params: { bodyHtml: string; footerReason: string }): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:${colorsLight.bg};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${colorsLight.bg};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" style="max-width:480px;background:${colorsLight.surface};border:1px solid ${colorsLight.border};border-radius:12px;padding:32px;">
            <tr>
              <td style="font-family:${SERIF};font-size:22px;font-weight:600;color:${colorsLight.accentText};padding-bottom:20px;">
                Keepsake
              </td>
            </tr>
            <tr>
              <td style="font-family:${SANS};font-size:16px;line-height:24px;color:${colorsLight.ink};">
                ${params.bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding-top:28px;margin-top:20px;border-top:1px solid ${colorsLight.border};font-family:${SANS};font-size:12px;line-height:18px;color:${colorsLight.textSecondary};">
                Keepsake · keepsake.ing · ${escapeHtml(params.footerReason)}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function footerLine(reason: string): string {
  return `Keepsake · keepsake.ing · ${reason}`;
}

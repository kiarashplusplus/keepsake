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

/**
 * Collapses CR/LF and other control characters out of a subject line.
 * Subject headers, unlike the HTML/text bodies, are never run through
 * `escapeHtml` — there's no markup to escape — so a title containing a raw
 * newline could otherwise inject extra header lines into the sent message.
 * `TitleSchema` (`packages/contracts/src/listing.ts`) now rejects control
 * characters on the way in, but `sendMail` is also called with titles read
 * straight back out of D1 rows written before that check existed, so this
 * runs at every `subject:` site regardless of whether the title was
 * revalidated.
 *
 * "Runs at every `subject:` site" was, until #86, only a claim in this
 * comment — and a false one: `requestReceived.ts` interpolated the listing
 * title raw. It is now an *enforced* rule with no exemptions: every
 * `subject:` in `src/email/templates/` must be `sanitizeSubject(...)`,
 * including the two static ones, so there is no judgement call about which
 * subjects "need" it and nothing for the next template to get wrong.
 * `test/emailSubjects.test.ts` enumerates this directory and fails on any
 * unwrapped site, so adding a seventh template without the wrapper is a red
 * test rather than a silent regression.
 */
export function sanitizeSubject(input: string): string {
  return input.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
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

/**
 * CASL s.6(2) sender identification + unsubscribe instruction, appended to
 * every template's footer regardless of whether that template's message is
 * transactional. Issue #310 raised the question this answers: s.6(6) exempts
 * a transactional CEM from s.6(1)(a)'s *consent* requirement only — it never
 * touches s.6(2), so every message this product sends (all seven-plus
 * templates below, including the admin-only ones) still needs these two
 * things. Living here rather than in each template is the point: a template
 * that builds its own footer independently is a template that can drift out
 * of compliance the next time someone edits it. See
 * `docs/design/email.md`'s "CASL: sender identification and unsubscribe"
 * for what remains open.
 *
 * **Identification (s.6(2)(a)).** Keepsake is not a company —
 * `apps/site/public/terms.html` says so plainly ("Keepsake isn't a company.
 * It's one person: Kiarash Adl, an individual in Texas doing business as
 * Keepsake") — so identification names that person, alongside the
 * `hello@keepsake.ing` contact every template already uses elsewhere.
 *
 * **What's deliberately missing: a mailing address.** s.6(2)(b) also asks
 * for one, valid 60+ days. `apps/site/public/privacy.html`'s "Who runs
 * this" section documents not publishing one as a considered choice, not an
 * omission — Kiarash operates from a home address and the reasoning there
 * (UK GDPR Art. 13 has no UK user to attach to since the UK is geo-blocked;
 * PIPEDA and the relevant US state laws ask for an accountable person and a
 * way to reach them, not a literal street address) is analysis, not a
 * decision that CASL's own address clause is satisfied. This file does not
 * invent, guess, or borrow an address to fill that gap. It stays open —
 * see `docs/design/email.md`.
 *
 * **Unsubscribe (s.6(2)(c)/6(3)).** CASL accepts a stated electronic
 * address the recipient can write to, provided requests are given effect
 * within 10 business days at no cost — it does not require a one-click
 * mechanism. That's what this line offers. It is NOT the one-click flow
 * CASL also permits (no token, no route, no storage exist for this yet),
 * and *honouring* a request against a message like `chosen` ("you were
 * chosen") or `confirmRequest` ("confirm your request") is a product
 * decision nobody has made — silently dropping either message defeats the
 * transaction it's part of. Both gaps are named in `docs/design/email.md`
 * rather than papered over here.
 */
export const CASL_IDENTIFICATION_LINE = "Sent by Kiarash Adl, an individual doing business as Keepsake.";
export const CASL_UNSUBSCRIBE_LINE =
  "To unsubscribe from messages like this, email hello@keepsake.ing and say so — requests are honored within 10 business days.";
export const CASL_FOOTER_LINES = [CASL_IDENTIFICATION_LINE, CASL_UNSUBSCRIBE_LINE];

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
                Keepsake · keepsake.ing · ${escapeHtml(params.footerReason)}<br /><br />
                ${CASL_FOOTER_LINES.map((line) => escapeHtml(line)).join("<br />")}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/**
 * Plain-text mirror of `renderShell`'s footer cell. Several templates build
 * their `text:` part by hand rather than stripping the HTML, so the CASL
 * lines have to be added here too — a footer that only existed in HTML
 * would be half a fix (#310).
 */
export function footerLine(reason: string): string {
  return [`Keepsake · keepsake.ing · ${reason}`, "", ...CASL_FOOTER_LINES].join("\n");
}

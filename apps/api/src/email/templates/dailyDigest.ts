import { colorsLight } from "@keepsake/tokens/colors";
import type { DailyReport, DailyReportAlert } from "@keepsake/contracts/observatory";
import { dailyReportSubject } from "../../report/daily.js";
import { escapeHtml, footerLine, renderShell, sanitizeSubject, type EmailTemplate } from "./shared.js";

/**
 * The daily ops digest (`cron/dailyDigest.ts`).
 *
 * Unlike every other template here, this one is not transactional and has
 * exactly one recipient: whoever `ADMIN_DIGEST_TO` names. That changes what
 * it should look like. The others are addressed to strangers and lead with
 * warmth; this is addressed to the person on call and leads with the
 * verdict, because the common case is that it is read on a phone, in a
 * notification preview, and never opened.
 *
 * So the structure is deliberately inverted relative to the rest of the
 * directory: conclusion first (`needs_attention`, or an explicit all-clear),
 * numbers second, and the numbers exist to answer "what changed" *after* the
 * reader has already decided whether to care.
 */

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

/**
 * Severity is carried by a text label, never by colour alone.
 *
 * Two reasons, both concrete rather than theoretical: a meaningful share of
 * mail clients strip or override inline colour (Outlook's dark mode inverts
 * it outright), and this is exactly the message that gets forwarded and
 * screenshotted. A digest whose only distinction between "critical" and
 * "watch this" is a shade of red is a digest that says nothing in the client
 * that renders it grey.
 */
function alertLine(alert: DailyReportAlert): { label: string; color: string } {
  return alert.severity === "critical"
    ? { label: "NEEDS ATTENTION", color: colorsLight.danger }
    : { label: "WATCH", color: colorsLight.accentText };
}

function renderAlertsHtml(alerts: DailyReportAlert[]): string {
  if (alerts.length === 0) {
    return `<p style="font-size:17px;margin:0 0 20px;"><strong>All clear.</strong> Nothing needs you today.</p>`;
  }

  const rows = alerts
    .map((alert) => {
      const { label, color } = alertLine(alert);
      return `<tr>
        <td style="padding:0 0 12px;">
          <span style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.08em;color:${color};">${label}</span><br />
          <span style="font-family:${SANS};font-size:15px;line-height:22px;color:${colorsLight.ink};">${escapeHtml(alert.detail)}</span>
        </td>
      </tr>`;
    })
    .join("");

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">${rows}</table>`;
}

/** One `label: value` line. Values are numbers we computed, but they go
 * through `escapeHtml` anyway — every string interpolated into this template
 * does, so there is no per-field judgement call about which ones are
 * "safe enough" to skip. */
function statRow(label: string, value: string): string {
  return `<tr>
    <td style="font-family:${SANS};font-size:14px;color:${colorsLight.textSecondary};padding:2px 12px 2px 0;">${escapeHtml(label)}</td>
    <td style="font-family:${SANS};font-size:14px;color:${colorsLight.ink};padding:2px 0;"><strong>${escapeHtml(value)}</strong></td>
  </tr>`;
}

/** Ages are reported in milliseconds by the report and in words by the
 * email. `null` renders as an em dash, never as "0" — an empty queue and a
 * queue whose oldest item just arrived are different facts. */
function ageWords(ms: number | null): string {
  if (ms === null) return "—";
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours >= 1) return `${hours}h`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m`;
}

export function dailyDigest(report: DailyReport): EmailTemplate {
  const reason = "you're getting this because you're the Keepsake admin. It sends every day, including quiet ones.";

  const alertsText =
    report.needs_attention.length === 0
      ? "All clear. Nothing needs you today."
      : report.needs_attention
          .map((alert) => `[${alert.severity === "critical" ? "NEEDS ATTENTION" : "WATCH"}] ${alert.detail}`)
          .join("\n");

  const stats: [string, string][] = [
    ["Listings created", String(report.listings.created)],
    ["Approved", String(report.listings.approved)],
    ["Rejected", String(report.listings.rejected)],
    ["Pending now", String(report.listings.pending_now)],
    ["Awaiting review now", String(report.listings.needs_review_now)],
    ["Oldest pending", ageWords(report.listings.oldest_pending_age_ms)],
    ["Requests", String(report.requests.created)],
    ["Chosen", String(report.requests.chosen)],
    [
      "Email",
      report.email.attempted === 0
        ? "none sent"
        : `${report.email.attempted - report.email.failed}/${report.email.attempted} delivered${
            report.email.top_error ? ` (${report.email.top_error})` : ""
          }`,
    ],
    ["AI budget (text)", `${report.budgets.mod_text.used}/${report.budgets.mod_text.limit}`],
    ["AI budget (image)", `${report.budgets.mod_image.used}/${report.budgets.mod_image.limit}`],
  ];

  const bodyHtml = `
    <p style="font-family:${SANS};font-size:13px;color:${colorsLight.textSecondary};margin:0 0 16px;">
      ${escapeHtml(report.date)} &middot; ${escapeHtml(report.environment)} &middot; ${escapeHtml(report.commit.slice(0, 8))}
    </p>
    ${renderAlertsHtml(report.needs_attention)}
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 8px;">
      ${stats.map(([label, value]) => statRow(label, value)).join("")}
    </table>`;

  const text = [
    `Keepsake — ${report.date} (${report.environment} ${report.commit.slice(0, 8)})`,
    "",
    alertsText,
    "",
    ...stats.map(([label, value]) => `${label}: ${value}`),
    "",
    footerLine(reason),
  ].join("\n");

  return {
    subject: sanitizeSubject(dailyReportSubject(report)),
    html: renderShell({ bodyHtml, footerReason: reason }),
    text,
  };
}

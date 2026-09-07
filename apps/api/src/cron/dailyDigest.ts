/**
 * Builds yesterday's digest and mails it to the admin, once a day.
 *
 * The job is deliberately thin: everything interesting is in
 * `report/daily.ts` (what the numbers are) and `email/templates/dailyDigest.ts`
 * (how they read). What lives here is the decision about *when not to send*,
 * which is the only judgement this file makes.
 */
import type { Env } from "../env.js";
import { isDeployed } from "../env.js";
import { dailyDigest as renderDigest } from "../email/templates/dailyDigest.js";
import { sendMail } from "../email/sendMail.js";
import { buildDailyReport } from "../report/daily.js";
import { captureMessage } from "@keepsake/observability/capture";

/**
 * Sends the digest for the UTC day that just ended.
 *
 * ## Why a missing recipient is a warning and not a throw
 *
 * `ADMIN_DIGEST_TO` unset is the normal state locally, in tests, and on any
 * deploy made before the var was added. Throwing would mark the cron
 * invocation failed with Cloudflare and — because `runCron` only writes the
 * `cron:last:dailyDigest` heartbeat on success — would make the job look
 * *stale*, which is the exact alarm this report exists to raise about other
 * jobs. A digest that reports itself broken because nobody asked for it
 * would be the first false positive in the system, and false positives are
 * how an alerting channel stops being read.
 *
 * So: build the report regardless (it is the cheap part, and building it
 * proves the queries still work), then either send it or log why not. The
 * heartbeat is written either way, because the job did do its job.
 *
 * Both of those sentences describe `runCron` (`index.ts`), and as of #165
 * they are mechanically true rather than aspirational: this file wrote no
 * heartbeat at all for as long as it existed, which pinned
 * `GET /api/admin/health` to `ok: false` on every deployed tier and put this
 * job's own name in every digest's `needs_attention`. One consequence worth
 * knowing rather than rediscovering: the report is built *before* the
 * heartbeat is written, so the first run after a deploy that has never
 * written the key still lists `dailyDigest` as stale in its own digest. It
 * clears itself on the next night's run, and the 26-hour `staleAfterMs` in
 * `cron/registry.ts` is wide enough that a daily job's own heartbeat is
 * never stale when it next looks at it.
 *
 * ## Why a send failure *is* loud
 *
 * If the recipient is configured and the send fails, nothing else will ever
 * mention it — the whole point of this channel is that it is the thing
 * watching, so a silent failure here removes the watcher. `captureMessage`
 * puts it in Workers Logs, where the Observatory's own `logs` panel will
 * surface it on the admin page. That is circular by construction (the
 * dashboard reports that the dashboard's email is broken) and it is still
 * worth doing, because the two failure modes it distinguishes — "no email
 * arrived because nothing was wrong" and "no email arrived because sending
 * is broken" — are otherwise identical from the reader's side.
 */
export async function dailyDigest(env: Env): Promise<void> {
  const report = await buildDailyReport(env);
  const to = env.ADMIN_DIGEST_TO as string | undefined;

  if (!to) {
    console.warn("dailyDigest: ADMIN_DIGEST_TO is unset, nothing sent", {
      date: report.date,
      needsAttention: report.needs_attention.length,
    });
    return;
  }

  const template = renderDigest(report);
  const result = await sendMail(env, {
    kind: "admin_digest",
    to,
    subject: template.subject,
    html: template.html,
    text: template.text,
  });

  if (result.sent) {
    console.log("dailyDigest: sent", {
      date: report.date,
      needsAttention: report.needs_attention.length,
    });
    return;
  }

  console.error("dailyDigest: send failed", { date: report.date, reason: result.reason });

  // Only alarm on a deployed Worker. Locally and in tests there is no email
  // provider configured at all, so `sendMail` correctly reports `sent:
  // false` on every run — capturing that as an incident would train the
  // reader to ignore the channel. Same distinction `isDeployed` was added
  // for in issue #123.
  if (isDeployed(env)) {
    captureMessage("dailyDigest: could not deliver the daily digest", "error", {
      tags: { cron: "dailyDigest" },
      extra: { date: report.date, reason: result.reason },
    });
  }
}

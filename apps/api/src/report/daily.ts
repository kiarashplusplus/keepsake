/**
 * The daily digest: one object describing one UTC day, built once and used
 * twice — emailed by `cron/dailyDigest.ts` and embedded in
 * `GET /api/admin/observatory` so the page and the email can never disagree
 * about what "needs attention" means.
 *
 * ## Why it sends every day, including when nothing is wrong
 *
 * The obvious design is to email only when something needs attention. It
 * cannot work here, because the most important thing this report can tell
 * Kiarash is that the Worker's scheduled jobs have stopped — and a digest
 * that only sends on bad news is silent in exactly that case, indeed silent
 * in *every* case where the thing that would have noticed is the thing that
 * broke. Sending unconditionally makes the absence of an email a signal in
 * its own right, and it is the only signal available for "the crons died"
 * that does not require another system watching this one.
 *
 * The cost of that choice is a daily email that is usually boring, and the
 * fix for that is the subject line rather than the schedule: an all-clear
 * says so in the subject and never has to be opened.
 *
 * ## What the numbers cover
 *
 * Two kinds, deliberately mixed and deliberately labelled:
 *
 *  - *Flow* over the completed UTC day named by `date` — listings created,
 *    requests made, email attempted. These never change after the fact,
 *    which is why the digest runs just after midnight UTC and reports the
 *    day that has just finished rather than the one in progress. A number
 *    that can still move is a number two readers can disagree about.
 *  - *State* as of the moment the report was built — queue depth, oldest
 *    pending age, budget counters, cron heartbeats. These are the
 *    "is something stuck right now" half, and a completed-day version of
 *    them would be useless: nobody needs to know the queue was fine at
 *    midnight.
 *
 * Every field name says which it is (`created` vs `pending_now`).
 */
import type { DailyReport, DailyReportAlert, DailyReportBudget, ObservatorySearchIndex } from "@keepsake/contracts/observatory";
import { fetchSearchIndex } from "../observatory/appMetrics.js";
import { readCronHeartbeats } from "../cron/registry.js";
import type { Env } from "../env.js";
import { parseIntVar, reportAutohideThreshold } from "../env.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Fraction of a daily budget that has to be spent before the digest says so.
 * 0.8 rather than 1.0 because an alert fired at exhaustion arrives after the
 * damage — once `mod_text` is spent, every subsequent listing parks in
 * `pending` until midnight UTC, and the giver sees nothing happen. 80% is
 * the last point at which raising the ceiling still prevents the outage
 * rather than merely explaining it.
 */
const BUDGET_ALERT_FRACTION = 0.8;

/**
 * How long a listing may sit in `pending` before the digest calls it stuck.
 *
 * `pending` is supposed to be a state a listing passes through in seconds —
 * the moderation pipeline runs inline on submit, and `moderationRetry`
 * sweeps every 5 minutes for anything the AI failed on. Six hours is far
 * past any legitimate retry sequence, so a listing older than this is not
 * slow, it is stranded, and there is a giver on the other end of it
 * refreshing a page that will never change.
 *
 * `needs_review` gets a longer fuse (below) because it is *supposed* to
 * wait: it means the model asked for a human, and a human is asleep some of
 * the time.
 */
const PENDING_STUCK_MS = 6 * HOUR_MS;
const NEEDS_REVIEW_STUCK_MS = 48 * HOUR_MS;
/**
 * Issue #208. `searchIndexRetry` runs hourly, so a listing that has been
 * un-indexed for six hours has had five chances to be re-embedded and taken
 * none of them. Below that, an un-indexed listing is the retry queue doing
 * its job; above it, something is refusing the same listing every hour and
 * nobody would otherwise hear about it.
 */
const SEARCH_INDEX_STUCK_MS = 6 * HOUR_MS;

/** `YYYY-MM-DD` for a UTC instant. */
function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Rounds an age to the largest sensible unit — "3d", "5h", "12m". Used only
 * in alert prose; the machine-readable ages stay in milliseconds. */
function humanAge(ms: number): string {
  if (ms >= DAY_MS) return `${Math.floor(ms / DAY_MS)}d`;
  if (ms >= HOUR_MS) return `${Math.floor(ms / HOUR_MS)}h`;
  return `${Math.max(1, Math.floor(ms / 60_000))}m`;
}

/**
 * Reads a global budget counter and its ceiling.
 *
 * The counter is read straight out of KV rather than through
 * `checkAndBump()`, for the same reason `GET /api/admin/stats` does it: a
 * report that reads a counter must never bump the counter it is reporting
 * on. A digest that spent one unit of the day's moderation budget every
 * morning would be an observability tool that changes the thing it observes.
 *
 * The fallback passed to `parseIntVar` matches the one at each enforcing call
 * site (`moderation/pipeline.ts`, `routes/photos.ts`). That duplication is
 * checked, not trusted: preflight's `var-usage` check asserts every code
 * fallback equals the value declared in `wrangler.toml` `[vars]`, so a
 * ceiling that drifts between here and the enforcing path fails CI.
 *
 * The caller passes the *value* (`env.MOD_TEXT_DAILY_BUDGET`) rather than
 * letting this function index `env` by a name string. Indexing by a computed
 * key reads identically at runtime and is invisible to that same preflight
 * check, which scans the source for literal `env.X` reads — so a var read
 * only through a computed key would be reported as "declared but read
 * nowhere" and, worse, a var *removed* from `wrangler.toml` would not be
 * reported at all. Preflight rejected the computed form outright when this
 * was first written, which is the check doing exactly its job.
 */
async function readBudget(
  env: Env,
  kind: string,
  varName: string,
  declared: string | undefined,
  fallback: number,
  day: string,
): Promise<DailyReportBudget> {
  const raw = await env.KV.get(`budget:${kind}:${day}`);
  const parsed = raw ? Number.parseInt(raw, 10) : 0;
  return {
    used: Number.isFinite(parsed) ? parsed : 0,
    limit: parseIntVar(varName, declared, fallback),
  };
}

interface DayFlowRow {
  listings_created: number;
  requests_created: number;
  requests_chosen: number;
  emails_attempted: number;
  emails_failed: number;
  listings_approved: number;
  listings_rejected: number;
}

/**
 * Every count for one closed UTC day, in one round trip.
 *
 * Written as correlated subqueries in a single statement rather than seven
 * separate `prepare().first()` calls because a digest that issues seven
 * sequential D1 round trips inside a cron is seven chances to time out, and
 * because the numbers should describe one instant — seven statements over a
 * live database can straddle a write and report a request whose listing they
 * did not count.
 */
async function fetchDayFlow(env: Env, dayStart: number, dayEnd: number): Promise<DayFlowRow> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM listings WHERE created_at >= ?1 AND created_at < ?2) AS listings_created,
       (SELECT COUNT(*) FROM requests WHERE created_at >= ?1 AND created_at < ?2) AS requests_created,
       (SELECT COUNT(*) FROM requests WHERE chosen_at >= ?1 AND chosen_at < ?2) AS requests_chosen,
       (SELECT COUNT(*) FROM email_events WHERE created_at >= ?1 AND created_at < ?2) AS emails_attempted,
       (SELECT COUNT(*) FROM email_events WHERE ok = 0 AND created_at >= ?1 AND created_at < ?2) AS emails_failed,
       (SELECT COUNT(DISTINCT listing_id) FROM moderation_events
         WHERE created_at >= ?1 AND created_at < ?2 AND kind IN ('decision','admin') AND verdict = 'approved') AS listings_approved,
       (SELECT COUNT(DISTINCT listing_id) FROM moderation_events
         WHERE created_at >= ?1 AND created_at < ?2 AND kind IN ('decision','admin') AND verdict = 'rejected') AS listings_rejected`,
  )
    .bind(dayStart, dayEnd)
    .first<DayFlowRow>();

  return (
    row ?? {
      listings_created: 0,
      requests_created: 0,
      requests_chosen: 0,
      emails_attempted: 0,
      emails_failed: 0,
      listings_approved: 0,
      listings_rejected: 0,
    }
  );
}

/**
 * Current queue depth and the age of the oldest thing in it.
 *
 * Counts here are *totals*, not the capped samples `GET /api/admin/health`
 * returns. That endpoint deliberately returns at most 20 auto-hidden
 * listings because it renders them as a list; a digest that took
 * `array.length` from that shape would silently report "20" forever once the
 * backlog passed twenty, which is precisely the point at which the number
 * starts to matter. Different question, so a different query rather than a
 * reused one.
 */
async function fetchStateNow(
  env: Env,
  now: number,
  threshold: number,
): Promise<{
  pending: number;
  needs_review: number;
  oldest_pending_age_ms: number | null;
  autohidden_awaiting_review: number;
  near_threshold: number;
}> {
  const nearFloor = Math.max(threshold - 1, 1);

  const [queue, pressure] = await Promise.all([
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'needs_review' THEN 1 ELSE 0 END) AS needs_review,
         MIN(CASE WHEN status = 'pending' THEN created_at END) AS oldest_pending
       FROM listings WHERE status IN ('pending','needs_review')`,
    ).first<{ pending: number | null; needs_review: number | null; oldest_pending: number | null }>(),
    // Same predicate as `fetchReportPressure` in routes/admin.ts — a listing
    // is "auto-hidden and unreviewed" when it is hidden, has a
    // `report_autohide` event, and has no `admin` event at or after it. Kept
    // as a count here rather than importing that function, which returns a
    // capped sample.
    env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM listings l
           WHERE l.status = 'hidden'
             AND EXISTS (SELECT 1 FROM moderation_events e
                          WHERE e.listing_id = l.id AND e.kind = 'report_autohide'
                            AND NOT EXISTS (SELECT 1 FROM moderation_events a
                                             WHERE a.listing_id = l.id AND a.kind = 'admin'
                                               AND a.created_at >= e.created_at))) AS autohidden,
         (SELECT COUNT(*) FROM listings WHERE status = 'approved' AND report_count >= ?) AS near_threshold`,
    )
      .bind(nearFloor)
      .first<{ autohidden: number; near_threshold: number }>(),
  ]);

  return {
    pending: queue?.pending ?? 0,
    needs_review: queue?.needs_review ?? 0,
    oldest_pending_age_ms: queue?.oldest_pending == null ? null : now - queue.oldest_pending,
    autohidden_awaiting_review: pressure?.autohidden ?? 0,
    near_threshold: pressure?.near_threshold ?? 0,
  };
}

/** The most common failure reason among the day's failed sends — enough to
 * tell a bounce from a policy refusal without opening the admin page. */
async function fetchTopEmailError(env: Env, dayStart: number, dayEnd: number): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(error, '(unspecified)') AS error, COUNT(*) AS count
       FROM email_events
      WHERE ok = 0 AND created_at >= ? AND created_at < ?
      GROUP BY error ORDER BY count DESC LIMIT 1`,
  )
    .bind(dayStart, dayEnd)
    .first<{ error: string; count: number }>();
  return row?.error ?? null;
}

/**
 * Turns the collected numbers into the short list of things worth acting on.
 *
 * The ordering rule is severity first, then the order the checks are written
 * — which is roughly "how directly does this hurt a real person right now".
 * A stranded giver outranks a budget trending high, which outranks a
 * moderation backlog, because the first has already gone wrong.
 *
 * A check that cannot fire is worse than no check, so every threshold here
 * is a named constant at the top of this file rather than a literal buried
 * in a condition, and every one of them is exercised by a test that pushes
 * the input across the boundary in both directions.
 */
function deriveAlerts(input: {
  now: number;
  state: Awaited<ReturnType<typeof fetchStateNow>>;
  flow: DayFlowRow;
  budgets: DailyReport["budgets"];
  crons: DailyReport["crons"];
  needsReviewOldestMs: number | null;
  searchIndex: ObservatorySearchIndex;
}): DailyReportAlert[] {
  const alerts: DailyReportAlert[] = [];

  for (const cron of input.crons) {
    if (!cron.stale) continue;
    alerts.push({
      severity: "critical",
      code: "cron_stale",
      detail:
        cron.last_run_at === null
          ? `Cron "${cron.name}" has no recorded run at all.`
          : `Cron "${cron.name}" last completed ${humanAge(input.now - cron.last_run_at)} ago.`,
    });
  }

  if (input.state.oldest_pending_age_ms !== null && input.state.oldest_pending_age_ms > PENDING_STUCK_MS) {
    alerts.push({
      severity: "critical",
      code: "listing_stuck_pending",
      detail: `${input.state.pending} listing(s) pending; the oldest has waited ${humanAge(input.state.oldest_pending_age_ms)}. A giver is watching a page that will not change.`,
    });
  }

  if (input.state.autohidden_awaiting_review > 0) {
    alerts.push({
      severity: "critical",
      code: "autohidden_awaiting_review",
      detail: `${input.state.autohidden_awaiting_review} listing(s) auto-hidden by reports and not yet reviewed. Either a harmful listing needs confirming or a legitimate one needs restoring.`,
    });
  }

  // Failures only alarm when there were enough attempts for a ratio to mean
  // something. One failed send out of one is a typo; the same failure across
  // every send that day is a refusal, and that is what this is looking for.
  if (input.flow.emails_failed > 0 && input.flow.emails_failed === input.flow.emails_attempted) {
    alerts.push({
      severity: "critical",
      code: "email_all_failed",
      detail: `All ${input.flow.emails_attempted} email send(s) failed. Nobody was notified of anything.`,
    });
  } else if (input.flow.emails_failed > 0) {
    alerts.push({
      severity: "warning",
      code: "email_failures",
      detail: `${input.flow.emails_failed} of ${input.flow.emails_attempted} email send(s) failed.`,
    });
  }

  for (const [kind, budget] of Object.entries(input.budgets)) {
    if (budget.limit <= 0) continue;
    const fraction = budget.used / budget.limit;
    if (fraction >= 1) {
      alerts.push({
        severity: "critical",
        code: "budget_exhausted",
        detail: `AI budget "${kind}" is spent (${budget.used}/${budget.limit}). Listings will park until midnight UTC.`,
      });
    } else if (fraction >= BUDGET_ALERT_FRACTION) {
      alerts.push({
        severity: "warning",
        code: "budget_high",
        detail: `AI budget "${kind}" is at ${Math.round(fraction * 100)}% (${budget.used}/${budget.limit}).`,
      });
    }
  }

  if (input.needsReviewOldestMs !== null && input.needsReviewOldestMs > NEEDS_REVIEW_STUCK_MS) {
    alerts.push({
      severity: "warning",
      code: "needs_review_backlog",
      detail: `${input.state.needs_review} listing(s) awaiting human review; the oldest has waited ${humanAge(input.needsReviewOldestMs)}.`,
    });
  }

  // Issue #208. The un-indexed count alone is not an alert: an embed that
  // failed a minute ago is what the hourly retry is for, and paging on it
  // would train the reader to ignore this digest. The *age* is the alert —
  // the same "a count is a level, an age is a verdict" rule the pending and
  // needs_review checks above follow.
  //
  // The embed-budget clause is #207's warning made concrete: when
  // `EMBED_DAILY_BUDGET` is spent, every re-embed of the day has been denied
  // and this backlog is that outage's symptom, not a second incident. Saying
  // so in the same sentence is the difference between one thing to fix and
  // two things to chase. `budget_exhausted` fires for the same day, so a
  // reader who acts on that one has already acted on this one.
  if (
    input.searchIndex.enabled &&
    input.searchIndex.oldest_unindexed_age_ms !== null &&
    input.searchIndex.oldest_unindexed_age_ms > SEARCH_INDEX_STUCK_MS
  ) {
    const embedBudget = input.budgets.embed;
    const embedSpent = embedBudget !== undefined && embedBudget.limit > 0 && embedBudget.used >= embedBudget.limit;
    alerts.push({
      severity: "warning",
      code: "search_index_backlog",
      detail:
        `${input.searchIndex.unindexed} of ${input.searchIndex.approved} approved listing(s) have no search vector; ` +
        `the oldest has waited ${humanAge(input.searchIndex.oldest_unindexed_age_ms)}. ` +
        (embedSpent
          ? "The embed budget is spent, which is the likely cause — this should clear itself after midnight UTC."
          : "They are still findable by title and story through full-text search; only ranking is degraded."),
    });
  }

  if (input.state.near_threshold > 0) {
    alerts.push({
      severity: "warning",
      code: "reports_near_threshold",
      detail: `${input.state.near_threshold} live listing(s) are one report away from being auto-hidden.`,
    });
  }

  return alerts;
}

/**
 * Builds the digest for the UTC day *before* `now`.
 *
 * `now` is injected rather than read from the clock so the whole report is
 * deterministic under test — every threshold above is a comparison against
 * it, and a test that cannot place "now" cannot exercise a boundary.
 */
export async function buildDailyReport(env: Env, now: number = Date.now()): Promise<DailyReport> {
  const dayEnd = Date.parse(`${utcDate(now)}T00:00:00Z`);
  const dayStart = dayEnd - DAY_MS;
  const date = utcDate(dayStart);

  const [flow, state, topEmailError, crons, modText, modImage, suggest, embed, needsReviewOldest, searchIndex] = await Promise.all([
    fetchDayFlow(env, dayStart, dayEnd),
    fetchStateNow(env, now, reportAutohideThreshold(env)),
    fetchTopEmailError(env, dayStart, dayEnd),
    readCronHeartbeats(env.KV, now),
    // Budget counters are keyed by *today's* date, not the reported day's:
    // they are current state, and yesterday's key has already rolled off.
    readBudget(env, "mod_text", "MOD_TEXT_DAILY_BUDGET", env.MOD_TEXT_DAILY_BUDGET, 1000, utcDate(now)),
    readBudget(env, "mod_image", "MOD_IMAGE_DAILY_BUDGET", env.MOD_IMAGE_DAILY_BUDGET, 3000, utcDate(now)),
    readBudget(env, "suggest", "SUGGEST_DAILY_BUDGET", env.SUGGEST_DAILY_BUDGET, 1000, utcDate(now)),
    // #208: the `embed` counter `search/reembed.ts` bumps, on the same
    // `budget:<kind>:<day>` key shape as the three above. Its default matches
    // `DEFAULT_EMBED_DAILY_BUDGET` there.
    readBudget(env, "embed", "EMBED_DAILY_BUDGET", env.EMBED_DAILY_BUDGET, 2000, utcDate(now)),
    env.DB.prepare("SELECT MIN(created_at) AS oldest FROM listings WHERE status = 'needs_review'").first<{
      oldest: number | null;
    }>(),
    // Issue #208, and the same function `GET /api/admin/observatory` calls —
    // the digest and the page must not be able to disagree about how many
    // listings are missing a vector, which is the whole reason `report` is
    // embedded in the Observatory payload in the first place.
    fetchSearchIndex(env, now),
  ]);

  const budgets = { mod_text: modText, mod_image: modImage, suggest, embed };
  const needsReviewOldestMs = needsReviewOldest?.oldest == null ? null : now - needsReviewOldest.oldest;

  return {
    date,
    generated_at: now,
    environment: env.ENVIRONMENT as string,
    commit: env.COMMIT_SHA as string,
    needs_attention: deriveAlerts({ now, state, flow, budgets, crons, needsReviewOldestMs, searchIndex }),
    listings: {
      created: flow.listings_created,
      approved: flow.listings_approved,
      rejected: flow.listings_rejected,
      pending_now: state.pending,
      needs_review_now: state.needs_review,
      oldest_pending_age_ms: state.oldest_pending_age_ms,
    },
    requests: { created: flow.requests_created, chosen: flow.requests_chosen },
    email: { attempted: flow.emails_attempted, failed: flow.emails_failed, top_error: topEmailError },
    reports: {
      autohidden_awaiting_review: state.autohidden_awaiting_review,
      near_threshold: state.near_threshold,
    },
    budgets,
    crons,
  };
}

/**
 * The subject line, which is the whole product for a reader who is not going
 * to open the mail. It has to answer "do I need to do something" before the
 * preview text is even rendered, so the verdict comes first and the date
 * second.
 */
export function dailyReportSubject(report: DailyReport): string {
  const critical = report.needs_attention.filter((alert) => alert.severity === "critical").length;
  const warnings = report.needs_attention.length - critical;

  if (critical > 0) return `Keepsake ${report.date}: ${critical} needs attention`;
  if (warnings > 0) return `Keepsake ${report.date}: ${warnings} to watch`;
  return `Keepsake ${report.date}: all clear`;
}

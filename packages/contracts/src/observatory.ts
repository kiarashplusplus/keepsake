/**
 * The Observatory: `GET /api/admin/observatory` and the daily digest that
 * renders the same numbers into an email.
 *
 * Its own module rather than more of `./admin.ts` because it answers a
 * different question. `admin.ts` is about *one listing* — who gave it, what
 * the model said, what an admin should do about it. This is about *the
 * system* — is it serving traffic, is anything stuck, is a budget about to
 * run out, did the crons run. They share an auth gate and nothing else.
 *
 * Everything here is a plain TS type, not a zod schema, for the reason
 * `AdminStats` gives: these are server-computed payloads the client renders,
 * never a client-submitted shape the server must validate. The one exception
 * is `ObservatoryQuery` below, which *is* client-submitted.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Source wrapper
// ---------------------------------------------------------------------------

/**
 * Why every externally-sourced panel is wrapped instead of being `T | null`.
 *
 * The Observatory reads from three places with three different failure
 * modes, and a `null` collapses all of them into one indistinguishable
 * "no data" that a dashboard renders as an empty chart. The three are
 * genuinely different and want different reactions from whoever is looking:
 *
 *  - `configured: false` — the credential or account id was never set. This
 *    is the *expected* state locally, in tests, and on any deploy before
 *    `CF_OBSERVATORY_TOKEN` exists. Nothing is broken; there is simply
 *    nothing to show. Renders as a setup hint, never as an alarm.
 *  - `ok: false` — configured, called, and the call failed (token revoked,
 *    Cloudflare 5xx, timeout). This *is* an alarm, and it is the state most
 *    likely to be silently misread as "no traffic" if it were a `null`.
 *  - `ok: true` — real data.
 *
 * The distinction is the whole reason this exists: an observability surface
 * that cannot tell "I did not look" from "I looked and saw nothing" is the
 * same class of defect as a rate limiter that never fires, and this repo has
 * filed that bug against itself twice already (the `/admin/health` verdict
 * that ignored its own cron timestamps, issue #89's auto-hides that paged
 * nobody). A dashboard is allowed to be empty. It is not allowed to be
 * confidently empty when it never asked.
 */
export type ObservatorySource<T> =
  | { state: "ok"; data: T }
  | { state: "error"; error: string }
  | { state: "unconfigured"; reason: string };

// ---------------------------------------------------------------------------
// Edge telemetry — Cloudflare GraphQL Analytics
// ---------------------------------------------------------------------------

/** One UTC day of edge traffic for the Worker script. `date` is `YYYY-MM-DD`
 * so it sorts lexically and joins against the app series below without a
 * timezone conversion at the render site. */
export type ObservatoryEdgeDay = {
  date: string;
  requests: number;
  errors: number;
  subrequests: number;
};

/**
 * `workersInvocationsAdaptive` for one script over the window.
 *
 * `errors` here is Cloudflare's count of invocations that *threw or were
 * terminated* — it is not the count of 4xx/5xx responses. A handled 500 that
 * the Worker returns deliberately does not appear here. Named `errors`
 * anyway because that is the field name in the upstream API and renaming it
 * would make the payload harder, not easier, to reconcile against the
 * Cloudflare dashboard sitting next to it.
 *
 * `cpu_time_p50_us`/`p99_us` are microseconds, as Cloudflare reports them —
 * not converted to milliseconds here, because the interesting values are
 * single-digit-millisecond and rounding them at the API would throw away the
 * resolution that makes a regression visible.
 */
export type ObservatoryEdge = {
  script: string;
  window_days: number;
  totals: { requests: number; errors: number; subrequests: number };
  cpu_time_p50_us: number | null;
  cpu_time_p99_us: number | null;
  by_day: ObservatoryEdgeDay[];
};

// ---------------------------------------------------------------------------
// Log telemetry — Workers Observability
// ---------------------------------------------------------------------------

/**
 * One `console.error`/`console.warn` line the Worker emitted, as returned by
 * the Workers Observability telemetry query.
 *
 * This is the read side of `@keepsake/observability`'s `capture.ts`: that
 * module writes structured objects to stdout specifically so Workers Logs
 * indexes their fields, and until now nothing in the product ever read them
 * back — they were only visible by opening the Cloudflare dashboard. The
 * fields kept here are the ones `capture.ts` guarantees it writes.
 *
 * `message` arrives already redacted, because `capture.ts` redacts *before*
 * logging (`redactDeep`/`redactString`). Nothing on this path re-redacts,
 * and nothing should need to — but note that means a log line written by
 * something other than `capture.ts` (a bare `console.error` elsewhere in the
 * Worker) is surfaced verbatim. Admin-gated for that reason.
 */
export type ObservatoryLogEvent = {
  ts: number;
  level: string;
  message: string;
  service: string | null;
  request_id: string | null;
};

export type ObservatoryLogs = {
  window_days: number;
  /** Counts over the whole window, which is the part that survives the
   * sample limit below — a spike of 4,000 identical errors and a single
   * one-off both return the same handful of `events`, and only these
   * totals tell them apart. */
  counts: { error: number; warning: number };
  /** Most recent first, capped — a feed, not an archive. */
  events: ObservatoryLogEvent[];
};

// ---------------------------------------------------------------------------
// App telemetry — our own D1, always available
// ---------------------------------------------------------------------------

/**
 * One UTC day of the product's own numbers, from D1. Deliberately the same
 * `date` key and window as `ObservatoryEdgeDay` so the two series line up on
 * one axis: "requests at the edge went up and listings created did not" is
 * the comparison worth being able to make at a glance, and it is impossible
 * if the two halves are bucketed differently.
 *
 * These come from D1 and need no Cloudflare credential at all, which is why
 * this panel is never an `ObservatorySource` — it cannot be unconfigured.
 * That is a deliberate floor: the Observatory is useful with zero external
 * setup, and the Cloudflare panels are additive.
 */
export type ObservatoryAppDay = {
  date: string;
  listings_created: number;
  listings_approved: number;
  listings_rejected: number;
  requests_created: number;
  requests_chosen: number;
  emails_ok: number;
  emails_failed: number;
};

/**
 * The give→get funnel over the window, as absolute counts at each step.
 *
 * Ratios are deliberately not computed here. At this catalogue size a single
 * listing moves a percentage by double digits, and a dashboard that renders
 * "50% approval rate" off a denominator of two invites exactly the wrong
 * conclusion. The counts are honest at any scale; the reader can divide when
 * the denominator is worth dividing by.
 */
export type ObservatoryFunnel = {
  window_days: number;
  photos_uploaded: number;
  listings_created: number;
  listings_approved: number;
  listings_requested: number;
  listings_chosen: number;
};

/**
 * How long listings are sitting before a human or the model clears them.
 *
 * `oldest_pending_age_ms` is the number that matters and the reason this
 * block exists: a `pending` count alone cannot distinguish twenty listings
 * that arrived in the last minute from one that has been stuck since
 * Tuesday, and only the second is an incident. Same shape of reasoning as
 * the cron-staleness check in `/api/admin/health` — a count is a level, an
 * age is a verdict.
 */
export type ObservatoryModerationLatency = {
  pending: number;
  needs_review: number;
  oldest_pending_age_ms: number | null;
  oldest_needs_review_age_ms: number | null;
  /** Median wall-clock from listing creation to leaving `pending`, over the
   * window. `null` when nothing left `pending` in the window at all — which
   * is a different statement from `0` and must not render as one. */
  median_time_to_decision_ms: number | null;
};

export type ObservatoryApp = {
  window_days: number;
  by_day: ObservatoryAppDay[];
  funnel: ObservatoryFunnel;
  moderation: ObservatoryModerationLatency;
};

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

/** Windows the client may ask for. A closed set rather than a free integer
 * because every extra day is another day of D1 aggregation and another day
 * of Cloudflare's GraphQL window; three choices cover "what happened today",
 * "what happened this week", and "is this a trend". Note Workers Logs on the
 * Free plan retains 3 days, so `logs` over a 30-day window is still only
 * ever ~3 days of events — reported honestly via `ObservatoryLogs.window_days`
 * rather than silently returning a short window under a long label. */
export const OBSERVATORY_WINDOWS = [1, 7, 30] as const;
export const ObservatoryWindowSchema = z.coerce
  .number()
  .int()
  .refine((n): n is (typeof OBSERVATORY_WINDOWS)[number] => (OBSERVATORY_WINDOWS as readonly number[]).includes(n), {
    message: `window_days must be one of ${OBSERVATORY_WINDOWS.join(", ")}`,
  });

export const ObservatoryQuery = z.object({
  window_days: ObservatoryWindowSchema.optional().default(7),
});
export type ObservatoryQuery = z.infer<typeof ObservatoryQuery>;

/** `GET /api/admin/observatory`. `report` is today's digest — the same object
 * the daily email renders — so the page and the email can never disagree
 * about what "needs attention" means. */
export type Observatory = {
  generated_at: number;
  environment: string;
  commit: string;
  window_days: number;
  app: ObservatoryApp;
  edge: ObservatorySource<ObservatoryEdge>;
  logs: ObservatorySource<ObservatoryLogs>;
  report: DailyReport;
};

// ---------------------------------------------------------------------------
// The daily digest
// ---------------------------------------------------------------------------

/**
 * Severity is a two-value set on purpose.
 *
 * A three-or-more level scheme (info/low/medium/high/critical) needs a rule
 * for what separates adjacent levels, and without one every alert drifts
 * upward until the top level means nothing. Two levels have a rule that can
 * actually be applied:
 *
 *  - `critical` — a giver or requester is currently having a broken
 *    experience, or will be within hours. Someone should look tonight.
 *  - `warning` — a trend that becomes critical if ignored. Someone should
 *    look this week.
 *
 * Anything that fits neither is not an alert; it is a number on the
 * dashboard, and it belongs in the body of the report rather than in
 * `needs_attention`.
 */
export type DailyReportSeverity = "critical" | "warning";

/**
 * `code` is a stable machine-readable slug (`cron_stale`,
 * `budget_exhausted`, …) and `detail` is the human sentence. Both, because
 * the email is read by a person and the endpoint may one day be read by
 * something that pages — and a report whose only output is prose can be
 * consumed by exactly one of those.
 */
export type DailyReportAlert = {
  severity: DailyReportSeverity;
  code: string;
  detail: string;
};

export type DailyReportBudget = {
  used: number;
  limit: number;
};

export type DailyReportCron = {
  name: string;
  last_run_at: number | null;
  stale: boolean;
};

/**
 * The daily digest, covering one UTC day.
 *
 * Sent every day whether or not anything is wrong — the absence of the email
 * is itself the signal that the Worker's crons have stopped, which is
 * precisely the failure a "only email when there's a problem" design cannot
 * report. The subject line carries the verdict so an all-clear costs one
 * glance and never has to be opened.
 */
export type DailyReport = {
  /** The UTC day covered, `YYYY-MM-DD`. Not "the day it was sent": a digest
   * that runs at 14:00 UTC covers the day that has just been fully lived,
   * so the numbers in it never change after the fact. */
  date: string;
  generated_at: number;
  environment: string;
  commit: string;
  /** Empty means all clear, and the email says so in as many words. */
  needs_attention: DailyReportAlert[];
  listings: {
    created: number;
    approved: number;
    rejected: number;
    pending_now: number;
    needs_review_now: number;
    oldest_pending_age_ms: number | null;
  };
  requests: { created: number; chosen: number };
  email: { attempted: number; failed: number; top_error: string | null };
  reports: { autohidden_awaiting_review: number; near_threshold: number };
  budgets: {
    mod_text: DailyReportBudget;
    mod_image: DailyReportBudget;
    suggest: DailyReportBudget;
  };
  crons: DailyReportCron[];
};

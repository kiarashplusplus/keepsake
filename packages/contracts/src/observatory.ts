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
import type { BatchItemState, BatchState, BulkOperationStatus } from "./bulk";

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

/**
 * How much of the public catalogue currently has no semantic-search vector
 * for its own text — issue #208.
 *
 * `listings.vector_indexed_at` (#180) made "this listing has no vector" a
 * queryable fact instead of silence, and then nothing read it: no panel, no
 * health field, no cron. A signal nobody looks at is one step from an empty
 * chart, which `AGENTS.md` calls the most convincing wrong answer there is.
 *
 * A union rather than a struct with a flag, for the same reason
 * `ObservatorySource` is one: with `SEMANTIC_SEARCH` off, `reembedListing`
 * returns before it records anything, so *every* listing reads as
 * un-indexed. That number is arithmetically true and says nothing about
 * health, and a dashboard that renders it next to a moderation backlog
 * invites exactly the wrong conclusion. So when the feature is off there is
 * no number to render at all.
 *
 * `oldest_unindexed_age_ms` for the reason `ObservatoryModerationLatency`
 * gives about its own ages: a count is a level, an age is a verdict. Five
 * listings that failed to embed in the last minute are the retry cron's
 * ordinary work; one that has been un-indexed since Tuesday is a stuck
 * backlog.
 */
export type ObservatorySearchIndex =
  | { enabled: false }
  | {
      enabled: true;
      /** Approved listings — the ones whose ranking a missing vector degrades. */
      approved: number;
      /** …of those, how many have no vector for their current text. */
      unindexed: number;
      /** Age of the longest-waiting un-indexed listing, by `updated_at`. */
      oldest_unindexed_age_ms: number | null;
    };

// ---------------------------------------------------------------------------
// Estate bulk upload — plan Stage 5. Same D1-derived, no-credential,
// always-present floor as the rest of `ObservatoryApp`: nothing here reaches
// Cloudflare, so there is no `ObservatorySource` wrapper.
//
// A pilot cannot be run on a feature whose only failure signal is a giver
// complaining, and until this existed nothing watched `upload_batches`,
// `upload_batch_items`, `upload_batch_photos`, `bulk_owner_usage` or
// `bulk_operations` at all — four tables a submission depends on, zero of
// them observed.
// ---------------------------------------------------------------------------

/**
 * `upload_batches.state`, per `BATCH_STATES`
 * (`@keepsake/contracts/bulk`) — `draft | submitting | closed | cancelled`.
 * A `Record` rather than an array of `{state, count}` pairs so a caller can
 * index it directly without a `.find()`, the same shape
 * `AdminStats.listings_by_status` already uses for the give flow's own
 * status breakdown.
 */
export type ObservatoryBulkBatches = {
  by_state: Record<BatchState, number>;
  /** `draft + submitting` — batches a giver could still be working, or that
   * a submission is still working through. Everything else (`closed`,
   * `cancelled`) is finished, in either direction. */
  active: number;
  /** `state = 'draft'` batches whose `expires_at` has already passed. Their
   * photos are already being reclaimed by `cron/orphanSweep.ts` on its next
   * nightly pass (the migration's own "reclamation for free" mechanism), but
   * the `upload_batches` row itself is never deleted — nothing sweeps it —
   * so this is the honest count of batches a giver started and then simply
   * never came back to. The plan's "draft abandonment" metric, at the level
   * this schema can actually answer it: a count of rows past their own
   * expiry, not a rate against batches started (see `ObservatoryFunnel`'s
   * own doc comment on why a ratio is deliberately not computed here either). */
  abandoned_draft: number;
};

/**
 * `upload_batch_items.state` — `editing | ready | queued | submitted |
 * failed` (`BATCH_ITEM_STATES`) — plus the two-state shape of
 * `upload_batch_photos` upload progress.
 *
 * `items_by_state.ready` is honest but structurally quiet: nothing in
 * `apps/api/src/bulk/submit.ts` or `routes/bulk.ts` ever writes
 * `state = 'ready'` — readiness (`BatchItemSummary.ready`) is computed live
 * on every read by `checkItemReadiness`, running the real
 * `CreateListingInput` over the assembled item, and is never persisted with
 * a timestamp. So this bucket reads `0` on every environment today, which is
 * correct, not a bug in this query — see this repo's report for the funnel
 * step ("first ready item") that fact makes unanswerable from the schema.
 */
export type ObservatoryBulkDrafts = {
  items_by_state: Record<BatchItemState, number>;
  /** Every item not yet `submitted` — `editing + ready + queued + failed`.
   * The work still outstanding across every batch, regardless of that
   * batch's own state. */
  items_outstanding: number;
  /** `upload_batch_photos` rows with `photo_id IS NULL` — the allowance was
   * charged and the row was written, but the bytes never finished landing in
   * R2 (see `20260908063000_bulk_photo_reservation.sql`'s header). A retry
   * resumes these; a reservation that sits here for a long time without one
   * is a giver who was charged for a photo they don't have. */
  photos_reserved: number;
  /** `upload_batch_photos` rows with `photo_id IS NOT NULL` — finished
   * uploads, whether or not they're attached to an item yet. */
  photos_stored: number;
};

/**
 * `bulk_operations.status` — `queued | running | done | cancelled`
 * (`BULK_OPERATION_STATUSES`) — plus the age of the oldest still-active one
 * and how many times an active operation's lease had to be recovered from a
 * crash rather than a clean release.
 *
 * `oldest_active_age_ms` is this panel's twin of
 * `ObservatoryModerationLatency.oldest_pending_age_ms`, for the same reason:
 * a depth of 3 that has been 3 for six hours is the failure this exists to
 * catch, and only an age says so. Measured from `created_at` — when the
 * submission was accepted — not from when the operation was last claimed, so
 * it answers "how long has this giver been waiting", not "how long has the
 * current lease been held".
 */
export type ObservatoryBulkOperations = {
  by_status: Record<BulkOperationStatus, number>;
  /** `queued + running`. */
  active: number;
  /** `null` means nothing is queued or running right now — genuinely
   * different from an age of zero, same rule every other `*_age_ms` field in
   * this file follows. */
  oldest_active_age_ms: number | null;
  /** `SUM(bulk_operations.stale_recoveries)` over only the operations
   * currently `queued`/`running` — see
   * `20260908072223_bulk_operation_lease_recovery.sql`'s header for exactly
   * what increments this column and why `attempts` alone cannot distinguish
   * it from ordinary multi-invocation chunking. Scoped to active operations
   * on purpose: an operation that needed one recovery and then finished
   * cleanly should not keep this number above zero forever — a rising count
   * *among work still in flight* is what means the runner is dying mid-run. */
  active_stale_lease_recoveries: number;
};

/**
 * `bulk_owner_usage` — how hard today's callers are pushing against the
 * per-owner daily ceilings (`BULK_OWNER_DAILY_ITEMS`, `_PHOTOS`,
 * `_SUGGESTIONS`).
 *
 * Scoped to `todayISO()`, because that is the row a write is actually
 * charged against right now — a historical total would answer a question
 * nobody is asking while a giver is stuck. `owners_at_limit` is the one
 * number here worth an alert: it counts callers whose next item, photo or
 * suggestion will be refused until UTC midnight, which is the shape of "a
 * giver emailed asking why their upload stopped".
 *
 * This replaced a `bulk_grants` panel when the admission code was removed.
 * Same question — is anything being refused — asked of the ceiling that is
 * still there.
 */
export type ObservatoryBulkUsage = {
  /** Owners with a `bulk_owner_usage` row for today. */
  owners_today: number;
  items_used: number;
  photos_used: number;
  suggestions_used: number;
  /** Owners who have hit at least one of the three ceilings today. */
  owners_at_limit: number;
};

/**
 * The plan's tracked funnel, windowed the same way `ObservatoryFunnel` is —
 * see that type's own doc comment for why this reports absolute counts and
 * never a computed ratio.
 *
 * This is a *cohort-adjacent* set of independent counts, not a strict
 * cohort like `ObservatoryFunnel`: `items_submitted`/`items_approved` are
 * scoped by when the *event* happened (`submitted_at` inside the window,
 * the listing's first `approved` `moderation_events` row inside the window),
 * not by when the owning batch was created — a batch started nine days ago
 * and submitted yesterday still counts as a submission this week. Doing it
 * as a cohort like the give-flow funnel would undercount every batch long
 * enough to outlive the window, which is the normal shape for an estate
 * prepared over several sittings.
 *
 * Three of the plan's named metrics are deliberately absent, and this repo's
 * own report says why in full: **the first-ready-item step** (never
 * persisted — see `ObservatoryBulkDrafts.items_by_state`'s doc comment),
 * **retry rate** (`bulk_operations.attempts` conflates ordinary
 * multi-invocation chunking with genuine failure-driven retries, and there
 * is no per-item retry counter), and **time to resume** (nothing timestamps
 * when a backed-off operation actually got picked back up, as distinct from
 * its own routine `next_attempt_at` scheduling).
 */
export type ObservatoryBulkFunnel = {
  window_days: number;
  /** `upload_batches.created_at` inside the window. */
  batches_started: number;
  /** `upload_batch_items.submitted_at` inside the window — the item passed
   * its claim and became a listing (not necessarily an *approved* one yet). */
  items_submitted: number;
  /** Of those, listings whose first `approved` `moderation_events` row also
   * falls inside the window. Not a cohort of `items_submitted` above: an
   * item submitted just before the window closes and approved just after it
   * opens again next week is still counted the day it actually clears. */
  items_approved: number;
  /** `SUM(photos.bytes_full)` for finished-upload `upload_batch_photos` rows
   * that never ended up attached to a submitted item, in a batch that is
   * `closed` or `cancelled` — i.e. the batch's fate is sealed and these
   * bytes will never become a listing. Real bytes (`photos.bytes_full`),
   * not a photo count, because "orphan bytes" is what the plan asks for and
   * R2 storage is what they actually cost. */
  orphan_bytes: number;
  /** Median wall-clock from listing creation to its first moderation
   * decision, over the window, split by whether the listing came from a
   * bulk item (`upload_batch_items.listing_id`) or the ordinary give flow —
   * the plan's "ordinary-versus-bulk processing latency" metric, answered
   * honestly because both halves already run through the same
   * `moderateListing` call and the same `moderation_events` log
   * (`src/bulk/submit.ts`'s own header on why there is no second
   * moderation path). `null` means nothing in that group left the queue
   * inside the window — see `ObservatoryModerationLatency.median_time_to_decision_ms`'s
   * doc comment on why that is a different fact from `0`. */
  moderation_latency_ordinary_median_ms: number | null;
  moderation_latency_bulk_median_ms: number | null;
};

/**
 * A union rather than a struct with a flag, same reasoning as
 * `ObservatorySearchIndex`: with `BULK_UPLOAD` off (local dev only as of
 * 2026-09-08 — it is `"1"` in both `[env.preview]` and `[env.production]`,
 * `apps/api/wrangler.toml`), no route accepts a new batch, so every number
 * below would either be a true, meaningless zero or —
 * worse, if historical rows from before the flag was flipped off still sit
 * in the tables — a number that looks live but describes a feature nobody
 * can currently reach. There is deliberately nothing to render either way.
 */
export type ObservatoryBulk =
  | { enabled: false }
  | {
      enabled: true;
      batches: ObservatoryBulkBatches;
      drafts: ObservatoryBulkDrafts;
      operations: ObservatoryBulkOperations;
      usage: ObservatoryBulkUsage;
      funnel: ObservatoryBulkFunnel;
    };

export type ObservatoryApp = {
  window_days: number;
  by_day: ObservatoryAppDay[];
  funnel: ObservatoryFunnel;
  moderation: ObservatoryModerationLatency;
  search_index: ObservatorySearchIndex;
  bulk: ObservatoryBulk;
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
 * The digest's own short block of the same bulk-upload numbers
 * `ObservatoryBulk` reports, so "a quiet day still reports" is true for
 * estate bulk upload too and not just for the give flow. `null` — not a
 * struct of zeros — mirrors `ObservatoryBulk`'s `{ enabled: false }`: with
 * `BULK_UPLOAD` off, there is nothing to report, and a zeroed block would
 * read as "bulk is quiet today" rather than the true "bulk is not reachable
 * in this environment".
 *
 * Deliberately a flat handful of "state now" numbers rather than the whole
 * nested `ObservatoryBulk` shape — the same trade this file already makes
 * for the search-index panel, whose full breakdown never appears in
 * `DailyReport` either, only its alert text and its budget line. The full
 * breakdown is one `.report`-adjacent `GET /api/admin/observatory` call away
 * for anyone who wants it.
 */
export type DailyReportBulk = {
  active_batches: number;
  items_outstanding: number;
  /** Same fact as `ObservatoryBulkOperations.oldest_active_age_ms`. */
  oldest_operation_age_ms: number | null;
  active_stale_lease_recoveries: number;
  orphan_bytes: number;
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
    /** Issue #208. `EMBED_DAILY_BUDGET` was the one AI budget the digest did
     * not report, so the day it ran out looked, from here, like nothing at
     * all — while every listing created or edited after it went un-indexed.
     * Reported for its own sake, and because the search-index alert reads it
     * to say whether a backlog is that outage rather than a second one. */
    embed: DailyReportBudget;
  };
  crons: DailyReportCron[];
  bulk: DailyReportBulk | null;
};

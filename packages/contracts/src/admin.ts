import { z } from "zod";
import { CursorSchema, MailableEmailSchema, PaginationLimitSchema, TimestampMs, UlidSchema } from "./common";
import { LISTING_STATUSES, ListingStatusSchema, MODERATION_REASON_CODES, OwnerListing } from "./listing";
import { ReportReasonSchema } from "./report";
import { RequestStatusSchema } from "./request";

/**
 * Shape returned by the vision model for each photo. Deliberately not
 * `.strict()`: the model is prompted for exactly these keys but is free to
 * add commentary fields, and we'd rather ignore extras than fail the parse.
 * Numeric fields are coerced because the model sometimes emits `"0.4"`.
 */
export const ImageVerdictSchema = z.object({
  /**
   * What the model says is in the frame, in a few words. Optional because it
   * was added after the first deploys, but the prompt asks for it first on
   * purpose: naming the subject before judging is what stopped the model
   * copying a pre-filled example (see apps/api/src/moderation/prompts.ts).
   */
  subject: z.string().max(120).optional(),
  is_physical_object: z.boolean(),
  nsfw: z.coerce.number().min(0).max(1),
  violence: z.coerce.number().min(0).max(1),
  weapons: z.coerce.number().min(0).max(1),
  drugs: z.coerce.number().min(0).max(1),
  hate_symbols: z.coerce.number().min(0).max(1),
  personal_info: z.coerce.number().min(0).max(1),
  notes: z.string().max(200),
});
export type ImageVerdict = z.infer<typeof ImageVerdictSchema>;

/** Llama Guard's `safe` / `unsafe\nS<codes>` output, parsed. */
export type TextVerdict =
  | { verdict: "safe" }
  | { verdict: "unsafe"; codes: string[] };

export const AdminActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approve"), listing_id: UlidSchema }),
  z.object({ type: z.literal("hide"), listing_id: UlidSchema, reason: z.string().max(500).optional() }),
  z.object({ type: z.literal("restore"), listing_id: UlidSchema }),
  z.object({ type: z.literal("ban"), owner_id: UlidSchema, reason: z.string().max(500).optional() }),
  z.object({ type: z.literal("unban"), owner_id: UlidSchema }),
]);
export type AdminAction = z.infer<typeof AdminActionSchema>;

// ---------------------------------------------------------------------------
// M4: GET /api/admin/queue and the admin actions in src/routes/admin.ts.
// ---------------------------------------------------------------------------

/** One row of `moderation_events` as shown in the admin queue — the
 * reasoning trail behind a listing's current status, not just the status
 * itself. `flags` is `flags_json` already parsed (`null` if there was none,
 * or if it failed to parse — a malformed row shouldn't break the whole
 * queue page). */
export const ModerationEventView = z.object({
  kind: z.string(),
  model: z.string().nullable(),
  verdict: z.string(),
  flags: z.unknown().nullable(),
  reason: z.string().nullable(),
  attempt: z.number().int().positive(),
  latency_ms: z.number().int().nonnegative().nullable(),
  created_at: TimestampMs,
});
export type ModerationEventView = z.infer<typeof ModerationEventView>;

/** One row of `reports` as shown in the admin queue. Deliberately omits
 * `ip_digest` — the admin queue is for reasoning about a listing, not for
 * re-identifying who reported it (see plan: no raw IPs, no digests, ever
 * returned to a client). */
export const AdminReportView = z.object({
  reason: ReportReasonSchema,
  details: z.string().nullable(),
  created_at: TimestampMs,
});
export type AdminReportView = z.infer<typeof AdminReportView>;

/** Giver identity as shown to the admin: enough to act on (ban) and to
 * gauge trust (verified email, prior bans), never the raw email — masked
 * the same way `@keepsake/contracts/request`'s `maskEmail` masks it
 * everywhere else a stranger-facing surface shows an email. */
export const AdminOwnerSummary = z.object({
  id: UlidSchema,
  email_masked: z.string().nullable(),
  email_verified: z.boolean(),
  banned: z.boolean(),
});
export type AdminOwnerSummary = z.infer<typeof AdminOwnerSummary>;

/**
 * `GET /api/admin/queue` item: every `OwnerListing` field (the giver's own
 * view of their listing) plus the admin-only context needed to decide on
 * it — who the giver is, how many reports it has, and the full moderation
 * history. Additive over the M1 `AdminQueueItem` (which was a bare alias for
 * `OwnerListing`): nothing that read the old shape read a field that moved.
 */
export const AdminQueueItem = OwnerListing.extend({
  report_count: z.number().int().nonnegative(),
  owner: AdminOwnerSummary,
  events: z.array(ModerationEventView),
  reports: z.array(AdminReportView),
});
export type AdminQueueItem = z.infer<typeof AdminQueueItem>;

export const ADMIN_QUEUE_STATUSES = ["needs_review", "hidden", "pending", "rejected"] as const;
export const AdminQueueStatusSchema = z.enum(ADMIN_QUEUE_STATUSES);
export type AdminQueueStatus = z.infer<typeof AdminQueueStatusSchema>;

export const AdminQueueQuery = z.object({
  status: AdminQueueStatusSchema,
  cursor: CursorSchema.optional(),
  limit: PaginationLimitSchema,
});
export type AdminQueueQuery = z.infer<typeof AdminQueueQuery>;

export const AdminHideInput = z.object({
  reason: z.string().trim().max(500).optional(),
});
export type AdminHideInput = z.infer<typeof AdminHideInput>;

export const AdminBanInput = z.object({
  reason: z.string().trim().max(500).optional(),
});
export type AdminBanInput = z.infer<typeof AdminBanInput>;

/**
 * Subset of `MODERATION_REASON_CODES` an admin can choose when hand-rejecting
 * a listing — excludes `budget` (an internal AI-budget-exhaustion marker,
 * never a real decision) and `held_for_review` (the `needs_review` state
 * itself, not a rejection). Listed explicitly, rather than derived by
 * filtering `MODERATION_REASON_CODES`, so the two internal-only codes this
 * deliberately excludes are visible right here, not implied by what's
 * missing from a `.filter()` call.
 */
export const ADMIN_REJECT_REASONS = [
  "contact_in_story",
  "not_an_object",
  "illegal_drugs",
  "violent_content",
  "sexual_content_minors",
  "weapons_of_mass_harm",
] as const satisfies readonly (typeof MODERATION_REASON_CODES)[number][];
export const AdminRejectInput = z.object({
  reason: z.enum(ADMIN_REJECT_REASONS),
});
export type AdminRejectInput = z.infer<typeof AdminRejectInput>;

/**
 * `email_events` grouped by outcome over a rolling window — the only bounce
 * signal that exists otherwise, since there is no bounce webhook or
 * complaint feedback loop (issue #6). `by_error` covers only the `ok = 0`
 * rows, one entry per distinct `sendMail()` reason (`blocked_reserved_domain`,
 * `send_failed: ...`, …), sorted most-frequent first, so a single
 * misconfigured allowlist entry or a real bounce pattern reads as a spike
 * rather than getting buried in one opaque "failures" count.
 */
export type AdminEmailEventStats = {
  window_days: number;
  total: number;
  ok: number;
  failed: number;
  by_error: { error: string; count: number }[];
};

/** `GET /api/admin/stats` — plain data, not a client-submitted shape, so
 * (like `@keepsake/contracts/feed`'s `FeedPage<T>`) this is a TS type rather
 * than a schema the client would ever need to validate against. */
export type AdminStats = {
  listings_by_status: Record<(typeof LISTING_STATUSES)[number], number>;
  requests_today: number;
  email_failures_today: number;
  ai_budget_used_today: {
    mod_text: number;
    mod_image: number;
  };
  email_events_7d: AdminEmailEventStats;
};

/**
 * `POST /api/admin/test-email` — launch-audit finding: email failures are
 * invisible and production has never delivered to anyone but Kiarash. This
 * sends a real message through the real `sendMail()` path (not a stub) to a
 * given address and reports back exactly what happened, so delivery is
 * verifiable on demand instead of inferred from whether a real giver
 * complained.
 */
export const AdminTestEmailInput = z.object({
  to: MailableEmailSchema,
});
export type AdminTestEmailInput = z.infer<typeof AdminTestEmailInput>;

/** `sent`/`reason` mirror `apps/api/src/email/sendMail.ts`'s `SendMailResult`
 * exactly — this endpoint is a thin, honest window onto that function, not a
 * reinterpretation of it. */
export type AdminTestEmailResult = {
  sent: boolean;
  reason: string | null;
  provider: string;
};

/**
 * `POST /api/admin/test-error` — issue #14's own "done" bar: a unit test
 * asserting `captureException`/`captureMessage`'s return value can't prove
 * an event actually reaches Workers Logs, only that the pure function ran.
 * This is a deliberate, diagnostic-only route that calls the real capture
 * path against a real deployed Worker so `wrangler tail` (or the Workers
 * Logs dashboard) can confirm a line actually lands — mirrors
 * `POST /api/admin/test-email` immediately above it in `apps/api/src/routes/
 * admin.ts`. `kind` picks which of the two capture functions fires;
 * `"exception"` (the default) throws-and-captures a synthetic `Error`,
 * `"message"` calls `captureMessage` at `"warning"` level instead.
 */
export const AdminTestErrorInput = z.object({
  kind: z.enum(["exception", "message"]).default("exception"),
});
export type AdminTestErrorInput = z.infer<typeof AdminTestErrorInput>;

export type AdminTestErrorResult = {
  captured: true;
  kind: "exception" | "message";
};

/**
 * Issue #89: `REPORT_AUTOHIDE_THRESHOLD` reports flip a live listing to
 * `hidden` on their own, and nothing told a human it happened —
 * `GET /health` is about the Worker, so it stayed `ok: true` throughout, and
 * the `captureMessage` the auto-hide fires only writes a line to Workers
 * Logs that nothing reads on a schedule. This is the same shape as
 * `cron_last_run` above it: the raw signal in the payload, so the admin
 * strip can render it and `AdminHealth.ok` can refuse to be green while it
 * is non-empty.
 *
 * - `autohidden_awaiting_review`: listings currently `hidden` whose most
 *   recent moderation event is a `report_autohide` — i.e. three strangers
 *   took a keepsake down and no admin has looked since. Clears itself the
 *   moment any admin action lands on the listing (restore, reject, hide),
 *   because that writes a newer `kind = 'admin'` event. This is the entry
 *   that flips `ok`, and it covers both directions of the risk: a genuinely
 *   harmful listing that needs confirming, and a legitimate one taken down
 *   by three coordinated reporters that needs restoring.
 * - `near_threshold`: still-`approved` listings one report away from the
 *   same fate (`report_count >= threshold - 1`). A heads-up, not a fault,
 *   so it deliberately does *not* affect `ok`.
 *
 * Listing ids only, never titles or reasons: a ULID is already in every
 * share link, and this payload is read by an admin who can look the rest up.
 */
export type AdminReportPressure = {
  threshold: number;
  autohidden_awaiting_review: { listing_id: string; report_count: number; autohidden_at: number }[];
  near_threshold: { listing_id: string; report_count: number }[];
};

/** `GET /api/admin/health` — same "plain data, not client input" rule as
 * `AdminStats` above. `cron_last_run` keys are cron job names
 * (`moderationRetry`, `orphanSweep`); a `null` value means that cron hasn't
 * run since this KV namespace was created (never observed in practice past
 * the first deploy, but honest for a fresh preview environment).
 *
 * `ok` is the one verdict for "does this backend need Kiarash right now",
 * and it is deliberately an AND of three unrelated things — seeded postal
 * codes, live cron heartbeats, and (issue #89) no unreviewed report
 * auto-hide. Launch audit finding 12 was `ok` ignoring a value that was
 * sitting right next to it; adding a field without folding it into the
 * verdict would repeat exactly that. */
export type AdminHealth = {
  ok: boolean;
  postal_codes_count: number;
  cron_last_run: Record<string, number | null>;
  report_pressure: AdminReportPressure;
};

// ---------------------------------------------------------------------------
// #70: GET /api/admin/requests/:id and POST /api/admin/requests/:id/remove.
//
// The minor-takedown rule (docs/runbooks/admin.md) was executable on the
// giver side (hide the listing, ban the owner) but not the requester side:
// there was no admin-facing view of a request's note, and no way to remove
// a single request without hiding/rejecting the whole listing — which would
// punish the giver for a requester's status. This is a targeted,
// look-up-by-id pair, not a queue: a request's note is written by a
// stranger to the giver, and streaming every note into a browsable admin
// list by default would be a real privacy change for a product that
// deliberately holds very little. A moderator who has been told about a
// specific request (e.g. a giver forwarding one) looks it up directly.
// ---------------------------------------------------------------------------

/**
 * `GET /api/admin/requests/:id` — deliberately not masked, unlike
 * `AdminOwnerSummary.email_masked`: the whole point of this endpoint is that
 * an admin cannot currently see a request's content at all, and a masked
 * email is often genuinely ambiguous (two different local parts sharing a
 * first letter and domain render identically). The giver already sees this
 * same raw email/phone once they choose a request — showing it here to the
 * one admin who already has direct D1 access is not a new class of
 * exposure, just a better-audited path than a manual `wrangler d1 execute`.
 * `note` is the field this endpoint exists for: the only place a request's
 * free-text note was visible before this was the giver's own dashboard.
 */
export const AdminRequestView = z.object({
  id: UlidSchema,
  listing_id: UlidSchema,
  listing_title: z.string(),
  listing_status: ListingStatusSchema,
  status: RequestStatusSchema,
  note: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  age_attested_at: TimestampMs.nullable(),
  created_at: TimestampMs,
  chosen_at: TimestampMs.nullable(),
  withdrawn_at: TimestampMs.nullable(),
  removed_at: TimestampMs.nullable(),
  removed_reason: z.string().nullable(),
});
export type AdminRequestView = z.infer<typeof AdminRequestView>;

/**
 * `POST /api/admin/requests/:id/remove` — mirrors `AdminHideInput`'s shape
 * (an optional free-text reason for the audit trail), not
 * `AdminRejectInput`'s enum: this reason is for `moderation_events` and
 * `requests.removed_reason`, both internal, never shown to the giver or the
 * requester the way a listing rejection reason is shown to the giver.
 */
export const AdminRemoveRequestInput = z.object({
  reason: z.string().trim().max(500).optional(),
});
export type AdminRemoveRequestInput = z.infer<typeof AdminRemoveRequestInput>;

export type AdminRequestRemoveResult = {
  id: string;
  listing_id: string;
  removed: true;
  removed_at: number;
};

// ---------------------------------------------------------------------------
// #37: POST /api/admin/backfill-aspects — one batch of the aspects backfill.
// ---------------------------------------------------------------------------

/**
 * Body for one batch of the aspects backfill (issue #37). `limit` bounds how
 * many pre-existing, aspect-less listings this single call processes —
 * small and admin-driven rather than one huge request, since each listing
 * costs a real (budget-metered) vision call and a Worker request has a CPU
 * time ceiling. Re-POSTing `{}` (or the same `limit`) repeatedly is the
 * normal way to drive the whole backfill to completion; see
 * `AdminBackfillAspectsResult.remaining`.
 */
export const AdminBackfillAspectsInput = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(5),
});
export type AdminBackfillAspectsInput = z.infer<typeof AdminBackfillAspectsInput>;

/**
 * Plain data, not a client-submitted shape — same rule as `AdminStats`
 * above. `with_aspects`/`without_aspects` are both "processed successfully";
 * they're split out because a run that's all `without_aspects` looks like a
 * bug (nothing came back) unless you can see that's actually what an honest
 * "no confident attributes" answer looks like across a batch.
 */
export type AdminBackfillAspectsResult = {
  processed: number;
  with_aspects: number;
  without_aspects: number;
  failed: number;
  budget_exhausted: boolean;
  remaining: number;
};

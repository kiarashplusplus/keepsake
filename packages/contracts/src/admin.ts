import { z } from "zod";
import { CursorSchema, PaginationLimitSchema, TimestampMs, UlidSchema } from "./common";
import { LISTING_STATUSES, MODERATION_REASON_CODES, OwnerListing } from "./listing";
import { ReportReasonSchema } from "./report";

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
};

/** `GET /api/admin/health` — same "plain data, not client input" rule as
 * `AdminStats` above. `cron_last_run` keys are cron job names
 * (`moderationRetry`, `orphanSweep`); a `null` value means that cron hasn't
 * run since this KV namespace was created (never observed in practice past
 * the first deploy, but honest for a fresh preview environment). */
export type AdminHealth = {
  ok: boolean;
  postal_codes_count: number;
  cron_last_run: Record<string, number | null>;
};

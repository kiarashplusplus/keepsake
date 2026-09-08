/**
 * Estate bulk upload: preparing many keepsakes over several sittings and
 * submitting the ready ones together.
 *
 * ## The one rule this module exists to keep
 *
 * **A draft is permissive; a submission is not.** Everything describing a
 * *draft* below accepts partial, half-written values — a title with no story,
 * no category at all — because a person clearing a house types what they know
 * when they know it, and a form that refuses to save an incomplete thought
 * loses the thought.
 *
 * Nothing here re-states a publishing rule. `DraftItemFields` is *derived*
 * from `./listing`'s `CreateListingInput` with `.pick().partial()`, so the
 * title bounds, the 20–2000 character story, the category enum and
 * `MAX_ASPECTS` have exactly one definition in this repository. The full
 * rules are applied once, at submission, by running that same
 * `CreateListingInput` over each assembled item — see
 * `apps/api/src/bulk/submit.ts`. A second copy of "a story is at least 20
 * characters" is a copy that drifts, and the drift stays invisible until a
 * bulk-created listing carries something `POST /api/listings` would have
 * refused.
 *
 * ## Client keys
 *
 * Batches, items, photos and operations are each addressed by a
 * caller-chosen key as well as a server id. The key is what makes a retry a
 * retry: a dropped response on "create this item" is re-sent with the same
 * key and resolves to the same row, where a fresh id would leave a duplicate
 * behind for every flaky moment on a phone in someone's late mother's house.
 * Uniqueness is a D1 unique index, not the KV replay cache in
 * `apps/api/src/middleware/idempotency.ts` — that cache is a response replay,
 * not a lock, and its own header says so.
 */
import { z } from "zod";
import { DateOfBirthSchema, TimestampMs, UlidSchema } from "./common";
import { CountrySchema } from "./geo";
import { MAX_PHOTOS } from "./photo";
import { CategorySchema, CreateListingInput, PostalCodeSchema, STORY_MAX } from "./listing";

/**
 * Pilot caps, per the feature plan. **Rollout settings to measure, not
 * demonstrated platform limits** — nothing has yet prepared 100 items in a
 * real browser, and the number that eventually holds is whatever a phone
 * turns out to survive.
 *
 * `MAX_PHOTOS` (5, from `./photo`) still bounds one item and is imported
 * rather than restated, for the reason its own comment gives.
 * `BULK_MAX_ITEMS_PER_BATCH` in `wrangler.toml` must never exceed
 * `MAX_BATCH_ITEMS`, or an operator raises the var, a giver prepares 120
 * items, and the submission 400s *after* the work. `apps/api/test/bulkCaps.test.ts`
 * asserts that from the real config text.
 */
export const MAX_BATCH_ITEMS = 100;
export const MAX_BATCH_PHOTOS = 300;

/**
 * Cover suggestions a single batch may ask for. Higher than `MAX_BATCH_ITEMS`
 * because a giver who regroups photos changes an item's cover, and the
 * suggestion for the old cover is then worth nothing — the headroom is for
 * that, not for a second opinion on the same picture.
 *
 * It exists at all because the give flow's ceiling cannot serve a batch:
 * `POST /api/photos/:id/suggest` is bounded by `SUGGEST_IP_DAILY_BUDGET`, a
 * per-IP KV counter defaulting to 30 a day, which a 100-item estate would
 * exhaust on item 31 — and a KV counter is eventually consistent by its own
 * documentation, so it could not bound a batch exactly even if the number
 * were bigger. Bulk suggestions are bounded the way bulk items and photos
 * already are: a guarded D1 decrement on `bulk_owner_usage`, this owner's
 * row for today.
 */
export const MAX_BATCH_SUGGESTIONS = 150;

/**
 * A caller-chosen key. Deliberately narrow: it lands in a unique index and in
 * error messages, so it carries no newlines, no control characters, and
 * nothing that would read as markup if a client rendered one back. Opaque to
 * the server, which never interprets it.
 */
export const ClientKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._:-]{1,64}$/, "Only letters, digits, and . _ : -");

/** Private, never published — see the migration's header. */
const BatchNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\x00-\x1f\x7f]*$/, "No line breaks or control characters");
const LabelSchema = z
  .string()
  .trim()
  .max(48)
  .regex(/^[^\x00-\x1f\x7f]*$/, "No line breaks or control characters");

export const BATCH_STATES = ["draft", "submitting", "closed", "cancelled"] as const;
export const BatchStateSchema = z.enum(BATCH_STATES);
export type BatchState = z.infer<typeof BatchStateSchema>;

export const BATCH_ITEM_STATES = ["editing", "ready", "queued", "submitted", "failed"] as const;
export const BatchItemStateSchema = z.enum(BATCH_ITEM_STATES);
export type BatchItemState = z.infer<typeof BatchItemStateSchema>;

export const BULK_OPERATION_STATUSES = ["queued", "running", "done", "cancelled"] as const;
export const BulkOperationStatusSchema = z.enum(BULK_OPERATION_STATUSES);
export type BulkOperationStatus = z.infer<typeof BulkOperationStatusSchema>;

export const CreateBatchInput = z.object({
  client_batch_key: ClientKeySchema,
  name: BatchNameSchema,
  country: CountrySchema,
  postal_code: PostalCodeSchema,
  shared_story: z.string().trim().max(STORY_MAX).optional(),
});
export type CreateBatchInput = z.infer<typeof CreateBatchInput>;

/**
 * `expected_revision` is required, not optional. An update that does not say
 * which version of the batch it was composed against cannot be checked for a
 * lost overwrite — and the whole premise of a draft that outlives a tab is
 * that a second tab exists.
 */
export const UpdateBatchInput = z.object({
  expected_revision: z.number().int().positive(),
  name: BatchNameSchema.optional(),
  country: CountrySchema.optional(),
  postal_code: PostalCodeSchema.optional(),
  shared_story: z.string().trim().max(STORY_MAX).nullable().optional(),
});
export type UpdateBatchInput = z.infer<typeof UpdateBatchInput>;

/**
 * The publishable half of a draft item, derived from the real create schema
 * rather than restated. `.partial()` is what makes a draft permissive; the
 * field *shapes* stay exactly the ones a listing is held to, so a draft can
 * never hold a category that is not in the enum or a story longer than a
 * listing may carry.
 *
 * Note what `.partial()` does not relax: `CreateListingInput.aspects` carries
 * `.default([])`, and zod v4 applies a default even under `.partial()` (the
 * behaviour `UpdateListingInput`'s comment documents), so an omitted
 * `aspects` key here parses as `[]`. That is the wanted reading for a draft —
 * "this item has no aspects yet" and "clear this item's aspects" are the same
 * request when nothing has been submitted.
 */
export const DraftItemFields = CreateListingInput.pick({
  title: true,
  story: true,
  category: true,
  aspects: true,
}).partial();
export type DraftItemFields = z.infer<typeof DraftItemFields>;

/**
 * One draft object.
 *
 * `photo_client_ids` is the grouping: the ordered set of this batch's photos
 * that make up this object, first one the cover. Sent whole rather than as
 * add/remove operations, so "group these three into one item" and "split that
 * group" are both just a new list and neither needs a server-side merge of
 * concurrent edits.
 *
 * `room_label` and `lot_label` are **private**. They tell a giver where the
 * object physically is; they are never serialized to a stranger and never
 * reach a listing.
 */
export const UpsertBatchItemInput = z.object({
  /** Omitted when creating; required to modify, so a lost overwrite is a 409
   * rather than a silent one. */
  expected_revision: z.number().int().positive().optional(),
  fields: DraftItemFields,
  room_label: LabelSchema.nullable().optional(),
  lot_label: LabelSchema.nullable().optional(),
  photo_client_ids: z.array(ClientKeySchema).max(MAX_PHOTOS).optional(),
});
export type UpsertBatchItemInput = z.infer<typeof UpsertBatchItemInput>;

/**
 * The submission. `items` names exactly which drafts to publish and the
 * revision each was reviewed at, so an edit landing between "review" and
 * "submit 42 items" is caught rather than published unseen.
 *
 * `date_of_birth` is the same one-per-submission age attestation the give
 * flow performs (issue #64), imported from `./common` rather than restated:
 * checked here, recorded as `listings.age_attested_at` on every listing the
 * submission creates, and — as everywhere else — never stored.
 */
export const SubmitBatchInput = z.object({
  op_key: ClientKeySchema,
  date_of_birth: DateOfBirthSchema,
  items: z
    .array(z.object({ client_item_id: ClientKeySchema, revision: z.number().int().positive() }))
    .min(1)
    .max(MAX_BATCH_ITEMS),
});
export type SubmitBatchInput = z.infer<typeof SubmitBatchInput>;

export const BatchPhotoSummary = z.object({
  client_photo_id: z.string(),
  photo_id: UlidSchema,
  item_client_id: z.string().nullable(),
  position: z.number().int().nonnegative(),
  /** `/i/:id/thumb`. Answers only to this owner's token until the photo's
   * listing is approved — `apps/api/src/routes/images.ts` already implements
   * exactly that, which is why bulk adds no image route of its own. */
  url_thumb: z.string(),
});
export type BatchPhotoSummary = z.infer<typeof BatchPhotoSummary>;

export const BatchItemSummary = z.object({
  id: UlidSchema,
  client_item_id: z.string(),
  title: z.string().nullable(),
  story: z.string().nullable(),
  category: CategorySchema.nullable(),
  room_label: z.string().nullable(),
  lot_label: z.string().nullable(),
  aspects: CreateListingInput.shape.aspects,
  photo_client_ids: z.array(z.string()),
  state: BatchItemStateSchema,
  revision: z.number().int().positive(),
  /** The listing this item became, from the moment the runner claims it. */
  listing_id: UlidSchema.nullable(),
  /**
   * True when this draft would pass `CreateListingInput` right now. Computed
   * by the API, not the client, so the summary line ("42 ready · 6 need
   * details") and the submission cannot disagree about what "ready" means.
   */
  ready: z.boolean(),
  /** Why it is not ready, or why publishing it failed — in the giver's
   * language, from the same validation the ordinary give flow runs. */
  blocked_reason: z.string().nullable(),
  created_at: TimestampMs,
  updated_at: TimestampMs,
});
export type BatchItemSummary = z.infer<typeof BatchItemSummary>;

export const BatchSummary = z.object({
  id: UlidSchema,
  client_batch_key: z.string(),
  name: z.string(),
  country: CountrySchema,
  postal_code: z.string(),
  place_name: z.string(),
  admin1: z.string().nullable(),
  shared_story: z.string().nullable(),
  state: BatchStateSchema,
  revision: z.number().int().positive(),
  item_count: z.number().int().nonnegative(),
  ready_count: z.number().int().nonnegative(),
  photo_count: z.number().int().nonnegative(),
  created_at: TimestampMs,
  updated_at: TimestampMs,
  /** When these drafts are reclaimed if nobody touches them again. Reads do
   * not move it; only a deliberate edit, upload or renewal does. */
  expires_at: TimestampMs,
});
export type BatchSummary = z.infer<typeof BatchSummary>;

export const BatchDetail = BatchSummary.extend({
  items: z.array(BatchItemSummary),
  photos: z.array(BatchPhotoSummary),
});
export type BatchDetail = z.infer<typeof BatchDetail>;

/**
 * A submission in flight. Returned with a 202 and polled afterwards.
 *
 * `succeeded + failed < total` means work is outstanding — a runner holds a
 * lease right now, or the recovery cron will pick it up. Nothing here reports
 * moderation: a submitted item's listing carries its own status, read from
 * `GET /api/me/listings` like any other, because copying a moderation outcome
 * into this table would be a second state machine racing the real one.
 */
export const BulkOperationSummary = z.object({
  id: UlidSchema,
  batch_id: UlidSchema,
  kind: z.literal("submit"),
  status: BulkOperationStatusSchema,
  total: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  created_at: TimestampMs,
  updated_at: TimestampMs,
  finished_at: TimestampMs.nullable(),
});
export type BulkOperationSummary = z.infer<typeof BulkOperationSummary>;

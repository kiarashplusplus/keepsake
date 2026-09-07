import { z } from "zod";
import { DateOfBirthSchema, MailableEmailSchema, TimestampMs, UlidSchema } from "./common";
import { CountrySchema } from "./geo";
import { AspectSchema, MAX_ASPECTS, PublicPhoto } from "./photo";
// Re-exported below so nothing outside the package needs to know these live
// in their own leaf module — see category.ts for why they aren't declared
// here directly (a circular import with photo.ts).
import { CATEGORIES, CATEGORY_LABELS, CategorySchema, TITLE_MAX, TITLE_MIN, type Category } from "./category";

export { CATEGORIES, CATEGORY_LABELS, CategorySchema, TITLE_MAX, TITLE_MIN, AspectSchema, MAX_ASPECTS };
export type { Category };
export type { Aspect } from "./photo";

export const LISTING_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "needs_review",
  "hidden",
  "given",
  "withdrawn",
] as const;

export const ListingStatusSchema = z.enum(LISTING_STATUSES);
export type ListingStatus = z.infer<typeof ListingStatusSchema>;

/** The only two statuses a stranger is ever allowed to see. */
export const PublicListingStatusSchema = z.enum(["approved", "given"]);
export type PublicListingStatus = z.infer<typeof PublicListingStatusSchema>;

export const STORY_MIN = 20;
export const STORY_MAX = 2000;

// Titles get interpolated straight into email subject headers (see
// `apps/api/src/email/templates/newRequest.ts`/`chosen.ts`), which are
// never HTML-escaped the way the body is — a raw `\n`/`\r` there could
// smuggle extra header lines into a sent message. `sanitizeSubject` in
// `apps/api/src/email/templates/shared.ts` is the runtime backstop for rows
// written before this check existed; this is the front door.
const TitleSchema = z
  .string()
  .trim()
  .min(TITLE_MIN)
  .max(TITLE_MAX)
  .regex(/^[^\x00-\x1f\x7f]*$/, "No line breaks or control characters");
const StorySchema = z.string().trim().min(STORY_MIN).max(STORY_MAX);
const PostalCodeSchema = z.string().trim().min(1).max(16);

export const CreateListingInput = z.object({
  title: TitleSchema,
  story: StorySchema,
  category: CategorySchema,
  country: CountrySchema,
  postal_code: PostalCodeSchema,
  photo_ids: z.array(UlidSchema).min(1).max(5),
  email: MailableEmailSchema.optional(),
  // Minimum age (docs/legal-considerations.md, issue #64): a neutral
  // "what is your date of birth?" prompt rather than an "I'm 18+" checkbox
  // — see `DateOfBirthSchema`'s own comment in `./common` for the reasoning
  // and for why the date itself is never persisted. Required only on
  // create; `UpdateListingInput` below needs no special override the way
  // `aspects` does, since this field carries no `.default()` for
  // `.partial()` to apply against a missing key — attesting once at
  // posting time is the point, not re-attesting on every edit.
  date_of_birth: DateOfBirthSchema,
  // eBay-style name/value attributes read off the cover photo by
  // `POST /api/photos/:id/suggest` (issue #36) — the give flow forwards
  // whatever suggestion it applied verbatim; there's no separate
  // aspect-editing UI. Optional + defaulted rather than required so an
  // older client, a failed/skipped suggestion, or a listing with no
  // confidently-identified attributes all mean the same harmless thing:
  // zero rows in `listing_aspects`. A listing is never gated on having any
  // — see apps/api/test/aspects.test.ts's zero-aspect feed/search guarantee
  // (issue #40's failure mode is exactly what this schema must not allow).
  aspects: z.array(AspectSchema).max(MAX_ASPECTS).default([]),
});
export type CreateListingInput = z.infer<typeof CreateListingInput>;

/**
 * `aspects` is overridden rather than left to `.partial()`'s usual
 * "wrap in `.optional()`" treatment: zod v4's `.optional()` on a field that
 * already carries `.default([])` still applies that default when the key is
 * missing from the request body (confirmed directly — `z.object({ a:
 * z.array(...).default([]) }).partial().parse({})` yields `{ a: [] }`, not
 * `{}`), which would make an absent `aspects` key on a `PATCH` body
 * indistinguishable from an explicit `aspects: []`. `routes/listings.ts`'s
 * PATCH handler needs exactly that distinction — "the client didn't mention
 * aspects" must leave a listing's existing ones alone, while "the client
 * sent an empty array" is a real (if unusual) request to clear them. A
 * plain `.optional()` with no default parses a missing key as `undefined`
 * and a present-but-empty array as `[]`, which is the distinction the route
 * needs. (Caught by `apps/api/test/aspects.test.ts`'s "PATCH omitting
 * aspects entirely leaves the existing ones untouched" — it failed against
 * the naive `.partial()` before this override was added.)
 */
export const UpdateListingInput = CreateListingInput.partial().extend({
  aspects: z.array(AspectSchema).max(MAX_ASPECTS).optional(),
});
export type UpdateListingInput = z.infer<typeof UpdateListingInput>;

/**
 * Giver-facing copy for each auto/human moderation outcome.
 *
 * `budget` (issue #18) used to be internal-only, on the theory that a giver
 * should never see the word "budget" — but that meant a listing stuck
 * because the day's moderation budget ran out looked, from the giver's
 * side, identical to one still going through the normal few-seconds check:
 * both were just `pending` with no reason shown. `apps/api` now persists
 * this reason on the listing itself (not only in the moderation log) the
 * moment a budget denial happens, and `GET /api/me/listings(/:id)` already
 * returns `moderation_reason` for every status, not only `rejected` — so
 * the API is telling the truth today; whether/how `apps/web` surfaces it
 * for a `pending` listing (currently its `mine/index.tsx` and `mine/[id].tsx`
 * only render `MODERATION_REASONS[...]` when `status === "rejected"`) is
 * for whoever owns that app to decide, since `pending` and `rejected` read
 * very differently to a giver.
 *
 * Declared ahead of `OwnerListing` below, which references
 * `ModerationReasonSchema` in its own initializer.
 */
export const MODERATION_REASON_CODES = [
  "contact_in_story",
  "not_an_object",
  "illegal_drugs",
  "violent_content",
  "sexual_content_minors",
  "weapons_of_mass_harm",
  "budget",
  "held_for_review",
] as const;

export type ModerationReasonCode = (typeof MODERATION_REASON_CODES)[number];
export const ModerationReasonSchema = z.enum(MODERATION_REASON_CODES);

export const MODERATION_REASONS: Record<ModerationReasonCode, string> = {
  contact_in_story: "Keep contact details out of the story. People reach you through Keepsake.",
  not_an_object: "Photos need to show the keepsake itself.",
  illegal_drugs: "This crosses a line we can't host: illegal drugs.",
  violent_content: "This crosses a line we can't host: violent content.",
  sexual_content_minors: "This crosses a line we can't host: sexual content involving minors.",
  weapons_of_mass_harm: "This crosses a line we can't host: weapons capable of mass harm.",
  budget: "More listings than usual today — yours is still in the queue and will be checked automatically, no action needed.",
  held_for_review: "Taking a closer look. Usually within a day.",
};

export const PublicListing = z.object({
  id: UlidSchema,
  title: z.string(),
  story: z.string(),
  category: CategorySchema,
  place_name: z.string(),
  admin1: z.string().nullable(),
  country: CountrySchema,
  status: PublicListingStatusSchema,
  photos: z.array(PublicPhoto),
  published_at: TimestampMs,
  given_at: TimestampMs.optional(),
  distance_mi: z.number().nonnegative().optional(),
  // Read-only here — set at create/edit time from the applied suggestion,
  // never edited directly by the client. Defaulted to `[]`, not optional:
  // every real response includes the key (possibly empty), so a consumer
  // can tell "no aspects" from "this field doesn't exist yet" without a
  // schema version check.
  aspects: z.array(AspectSchema).default([]),
});
export type PublicListing = z.infer<typeof PublicListing>;

export const OwnerListing = PublicListing.omit({ status: true }).extend({
  status: ListingStatusSchema,
  // Giver-only: the normalized postal code (not the raw input) so the web
  // dashboard's Edit step can prefill it. Deliberately not on `PublicListing`
  // — a stranger only ever sees `place_name`/`admin1`, never the postcode
  // itself.
  postal_code: z.string(),
  moderation_reason: ModerationReasonSchema.nullable(),
  request_count: z.number().int().nonnegative(),
  chosen_request_id: UlidSchema.nullable(),
  version: z.number().int().positive(),
  created_at: TimestampMs,
  updated_at: TimestampMs,
  held: z.boolean(),
});
export type OwnerListing = z.infer<typeof OwnerListing>;

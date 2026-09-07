import { z } from "zod";
import { AgeAttestationSchema, MailableEmailSchema, TimestampMs, UlidSchema } from "./common";
import { CountrySchema } from "./geo";
import { PublicPhoto } from "./photo";
// Re-exported below so nothing outside the package needs to know these live
// in their own leaf module — see category.ts for why they aren't declared
// here directly (a circular import with photo.ts).
import { CATEGORIES, CATEGORY_LABELS, CategorySchema, TITLE_MAX, TITLE_MIN, type Category } from "./category";

export { CATEGORIES, CATEGORY_LABELS, CategorySchema, TITLE_MAX, TITLE_MIN };
export type { Category };

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

const TitleSchema = z.string().trim().min(TITLE_MIN).max(TITLE_MAX);
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
  // Minimum age (docs/legal-considerations.md): required only on create, not
  // on `UpdateListingInput` below (`.partial()` makes it optional there) —
  // attesting once at posting time is the point, not re-attesting on every
  // edit.
  age_attested: AgeAttestationSchema,
});
export type CreateListingInput = z.infer<typeof CreateListingInput>;

export const UpdateListingInput = CreateListingInput.partial();
export type UpdateListingInput = z.infer<typeof UpdateListingInput>;

/**
 * Giver-facing copy for each auto/human moderation outcome. `budget` is
 * internal only (moderation exhausted its daily AI budget) and must never be
 * shown to a giver — the listing just stays `pending` until the cron retry.
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
  budget: "Internal: moderation budget exhausted for the day.",
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

import { z } from "zod";
import { DateOfBirthSchema, MailableEmailSchema, TimestampMs, UlidSchema } from "./common";
import { CountrySchema } from "./geo";
import { AspectSchema, MAX_ASPECTS, MAX_PHOTOS, PublicPhoto } from "./photo";
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
/** Exported so `./bulk`'s draft batch schemas can hold a postcode without
 * restating the bound — the same "one number, both sides" reasoning the
 * `photo_ids` field below gives for `MAX_PHOTOS`. */
export const PostalCodeSchema = z.string().trim().min(1).max(16);

export const CreateListingInput = z.object({
  title: TitleSchema,
  story: StorySchema,
  category: CategorySchema,
  country: CountrySchema,
  postal_code: PostalCodeSchema,
  // `MAX_PHOTOS`, not a literal `5`: `apps/web/app/give/index.tsx` sizes the
  // photo picker from that constant, so a literal here is a cap the client
  // can be raised past. Change the constant to 6 and the give flow offers
  // six slots, uploads six photos, and only then does this schema 400 the
  // create — after the work, with a validation error and no way back to the
  // photos step. One number, both sides.
  photo_ids: z.array(UlidSchema).min(1).max(MAX_PHOTOS),
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
 * `PUT /api/listings/:id/category` — the giver's own correction of what the
 * model decided their object is (issue #155).
 *
 * Its own route, and its own one-field input, rather than a `PATCH` carrying
 * only `category`. `PATCH` bumps `version`, resets `status` to `pending` and
 * re-runs the moderation pipeline, which is right for title/story/photos —
 * free text and images a stranger will read — and wrong here. A category is
 * a closed enum this product defines; there is no sentence in it to moderate,
 * and nothing about picking the correct one of twelve labels should take a
 * live listing out of the feed for a moderation cycle. Correcting "other" to
 * "tools" would otherwise cost the giver their listing's visibility, which is
 * exactly the tax that stops people correcting anything.
 */
export const SetListingCategoryInput = z.object({ category: CategorySchema });
export type SetListingCategoryInput = z.infer<typeof SetListingCategoryInput>;

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
  /**
   * When the giver last chose this listing's category themselves, or `null`
   * while the model's suggestion stands (issue #155).
   *
   * Giver-only, like `postal_code` above: a stranger has no business knowing
   * whether a category was guessed or corrected, and the distinction would
   * read as a confidence score on someone's keepsake. The dashboard uses it
   * for one thing — whether to say "we guessed this" or "you set this" — and
   * `POST /api/admin/listings/:id/resuggest` uses it to leave a corrected
   * category alone.
   */
  category_chosen_at: TimestampMs.nullable(),
});
export type OwnerListing = z.infer<typeof OwnerListing>;

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------
/**
 * Why a listing needs its giver, when nothing about its own `status` says so.
 *
 * `status` answers "what did moderation decide", which is the only question
 * the dashboard used to ask of a listing. It cannot answer the two that
 * actually strand people:
 *
 * - the giver has no reachable address, so `POST /api/requests/confirm`'s
 *   owner-notify is skipped entirely (`apps/api/src/routes/requestConfirm.ts`
 *   mails only a giver whose address is present *and* verified) and every ask
 *   waits on the giver happening to reopen `/mine` on the one device that
 *   holds their token;
 * - somebody asked, was confirmed, and is still waiting — an `open` request
 *   is a stranger who wrote a note and has heard nothing back.
 *
 * Both are conditions a live listing can sit in indefinitely while every
 * status label on the screen reads "Live". Naming them as data, rather than
 * deriving them ad hoc in one screen's JSX, is what lets the two dashboard
 * views, their tests, and anything later (a digest, a nudge mail) agree on
 * one definition.
 */
export const LISTING_STALE_REASONS = ["requests_unanswered", "email_missing", "email_unverified"] as const;
export const ListingStaleReasonSchema = z.enum(LISTING_STALE_REASONS);
export type ListingStaleReason = z.infer<typeof ListingStaleReasonSchema>;

/**
 * How long an `open` request may sit before the listing carrying it is
 * called stale. 72 hours, deliberately the same span as a request's own
 * confirmation window (`docs/design/identity.md`): the requester was given
 * three days to prove their address, so the giver gets three days to answer
 * before the dashboard starts saying someone is waiting.
 *
 * It is not zero because a fresh ask is not a neglected one — flagging every
 * request the moment it lands would make the flag mean "you have requests",
 * which `request_count` already says.
 */
export const UNANSWERED_REQUEST_STALE_MS = 72 * 60 * 60 * 1000;

/**
 * The statuses where any of this matters. A given, withdrawn, rejected or
 * hidden listing takes no new asks and needs no reachable giver, so flagging
 * one would be pure noise on a screen whose whole job is to show the few
 * things that need a hand.
 */
export const STALE_ELIGIBLE_STATUSES: readonly ListingStatus[] = ["pending", "needs_review", "approved"];

/** What the owner row says about being reachable, reduced to the only three
 * cases that change the answer. `unverified` is its own case rather than a
 * flavour of "has an email": an unverified address is mailed nothing at all
 * except its own verification link, so it is exactly as unreachable as no
 * address, and the giver's fix for it is different. */
export const OWNER_EMAIL_STATES = ["missing", "unverified", "verified"] as const;
export const OwnerEmailStateSchema = z.enum(OWNER_EMAIL_STATES);
export type OwnerEmailState = z.infer<typeof OwnerEmailStateSchema>;

export const ListingStaleness = z.object({
  /** Empty when nothing is wrong. Ordered by the pure function below, most
   * human cost first — a person waiting outranks an unset preference. */
  reasons: z.array(ListingStaleReasonSchema),
  /** When the oldest unanswered ask arrived, present only when
   * `requests_unanswered` is among the reasons — so a client rendering "4
   * days" can never draw it from a listing that is not actually waiting. */
  waiting_since: TimestampMs.nullable(),
});
export type ListingStaleness = z.infer<typeof ListingStaleness>;

/** `OwnerListing` plus the block above: what the two dashboard routes
 * (`GET /api/me/listings`, `GET /api/me/listings/:id`) answer with.
 *
 * A separate schema rather than a field on `OwnerListing` itself, because
 * staleness is a fact about a listing *and its owner's mailbox* at a moment
 * in time, and the other seven routes that serialize an `OwnerListing`
 * (create, edit, given/withdraw/relist, the admin queue) have neither the
 * owner's email state nor the request rows in hand. Widening `OwnerListing`
 * would have made every one of them answer a question it cannot see — the
 * failure mode being an empty `reasons: []` that reads as "nothing wrong"
 * when it means "nobody looked". Required here, so a dashboard route that
 * forgot to compute it fails the client's parse instead. */
export const OwnerDashboardListing = OwnerListing.extend({
  staleness: ListingStaleness,
});
export type OwnerDashboardListing = z.infer<typeof OwnerDashboardListing>;

export interface ListingStalenessInput {
  status: ListingStatus;
  /** Non-null the moment the giver picks someone: the ask has been answered,
   * whatever happens next, so the listing stops waiting. */
  chosen_request_id: string | null;
  owner_email_state: OwnerEmailState;
  /** `created_at` of the oldest *confirmed, still-open* request on this
   * listing, or `null` when there is none. Confirmed-only is the same rule
   * every other owner-facing read applies (`confirmed_at IS NOT NULL`, issue
   * #188): an unconfirmed submission is not somebody waiting, it is an
   * address nobody has proved they control. */
  oldest_open_request_at: number | null;
  now: number;
}

/**
 * The one definition of "this listing needs you", shared by the API (which
 * computes it) and the tests that pin it. Pure — every input is passed in,
 * including `now` — so the 72-hour boundary is testable without waiting or
 * mocking a clock.
 */
export function listingStaleness(input: ListingStalenessInput): ListingStaleness {
  if (!STALE_ELIGIBLE_STATUSES.includes(input.status)) {
    return { reasons: [], waiting_since: null };
  }

  const reasons: ListingStaleReason[] = [];
  const waiting =
    input.chosen_request_id === null &&
    input.oldest_open_request_at !== null &&
    input.now - input.oldest_open_request_at >= UNANSWERED_REQUEST_STALE_MS;

  if (waiting) reasons.push("requests_unanswered");
  if (input.owner_email_state === "missing") reasons.push("email_missing");
  if (input.owner_email_state === "unverified") reasons.push("email_unverified");

  return { reasons, waiting_since: waiting ? input.oldest_open_request_at : null };
}

/**
 * One sentence per reason, in the product's voice, kept beside the enum so a
 * new reason cannot ship without its copy. Second person, no exclamation, and
 * each one says what happens rather than scolding — the giver did nothing
 * wrong, the situation just needs them.
 */
export const LISTING_STALE_MESSAGES: Record<ListingStaleReason, string> = {
  requests_unanswered: "Someone asked for this and is still waiting to hear back.",
  email_missing: "No email on this device, so nobody can reach you about this.",
  email_unverified: "Your email isn't verified yet, so we can't send you asks about this.",
};

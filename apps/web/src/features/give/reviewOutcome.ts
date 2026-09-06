/**
 * Pure mapping from a polled listing's status to what the review step shows
 * — kept separate from `app/give/review.tsx` so the branching (and the
 * "what step does this rejection reason send you back to" rule) is
 * unit-testable without rendering anything or faking a poll loop.
 */
import type { ListingStatus, ModerationReasonCode } from "@keepsake/contracts/listing";

export type ReviewOutcome =
  | { kind: "waiting" }
  | { kind: "approved" }
  | { kind: "rejected"; reason: ModerationReasonCode | null }
  | { kind: "needs_review" }
  | { kind: "timeout" };

export function resolveReviewOutcome(
  status: ListingStatus,
  moderationReason: ModerationReasonCode | null,
  timedOut: boolean,
): ReviewOutcome {
  if (status === "approved" || status === "given") return { kind: "approved" };
  if (status === "rejected") return { kind: "rejected", reason: moderationReason };
  if (status === "needs_review") return { kind: "needs_review" };
  if (timedOut) return { kind: "timeout" };
  return { kind: "waiting" };
}

export type EditStep = "photos" | "story";

/** Where the "Edit" action on a rejected listing should send the giver. */
export function editStepForReason(reason: ModerationReasonCode | null): EditStep {
  if (reason === "not_an_object") return "photos";
  return "story";
}

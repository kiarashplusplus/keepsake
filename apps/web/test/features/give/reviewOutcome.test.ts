import { editStepForReason, resolveReviewOutcome } from "@/features/give/reviewOutcome";

describe("resolveReviewOutcome", () => {
  it("is waiting while pending and not timed out", () => {
    expect(resolveReviewOutcome("pending", null, false)).toEqual({ kind: "waiting" });
  });

  it("is approved for both approved and given", () => {
    expect(resolveReviewOutcome("approved", null, false)).toEqual({ kind: "approved" });
    expect(resolveReviewOutcome("given", null, false)).toEqual({ kind: "approved" });
  });

  it("carries the moderation reason when rejected", () => {
    expect(resolveReviewOutcome("rejected", "contact_in_story", false)).toEqual({ kind: "rejected", reason: "contact_in_story" });
  });

  it("is needs_review as its own state", () => {
    expect(resolveReviewOutcome("needs_review", null, false)).toEqual({ kind: "needs_review" });
  });

  it("is timeout only once pending AND timed out", () => {
    expect(resolveReviewOutcome("pending", null, true)).toEqual({ kind: "timeout" });
    expect(resolveReviewOutcome("approved", null, true)).toEqual({ kind: "approved" });
  });
});

describe("editStepForReason", () => {
  it("sends not_an_object back to the photos step", () => {
    expect(editStepForReason("not_an_object")).toBe("photos");
  });

  it("sends every other reason (including none) back to the story step", () => {
    expect(editStepForReason("contact_in_story")).toBe("story");
    expect(editStepForReason("illegal_drugs")).toBe("story");
    expect(editStepForReason(null)).toBe("story");
  });
});

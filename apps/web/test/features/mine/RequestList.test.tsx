// Issue #355: `RequestList`'s empty state was one sentence for every listing
// status — "No one has asked yet. Share the link." — so a given listing told
// its giver to share a link to something already handed over, and the item
// page a stranger would land on has no "I'd love this" button. The list now
// takes the listing's status and says what an empty list means *there*.
//
// Exhaustive over `LISTING_STATUSES` rather than a hand-picked few: the fix is
// a `Record<ListingStatus, string>`, and this is the test that notices when a
// new status lands in that record with the wrong sentence.
import * as React from "react";
import { render } from "@testing-library/react-native";
import { LISTING_STATUSES, type ListingStatus } from "@keepsake/contracts/listing";
import { RequestList } from "@/features/mine/RequestList";

function renderEmpty(status: ListingStatus): string {
  const instance = render(<RequestList requests={[]} status={status} canChoose={false} busy={false} onChoose={() => undefined} />);
  return JSON.stringify(instance.toJSON());
}

describe("RequestList empty state by listing status (#355)", () => {
  it("invites sharing on a live listing, and nowhere else", () => {
    const inviting = LISTING_STATUSES.filter((status) => renderEmpty(status).includes("Share the link"));
    expect(inviting).toEqual(["approved"]);
  });

  it("says nobody asked before it found a home, once given", () => {
    const shown = renderEmpty("given");
    expect(shown).toContain("Nobody asked through Keepsake before this found its home.");
    expect(shown).not.toContain("yet");
  });

  it("keeps 'yet' for a listing moderation has not yet made live", () => {
    for (const status of ["pending", "needs_review"] as const) {
      const shown = renderEmpty(status);
      expect(shown).toContain("No one has asked yet.");
      expect(shown).not.toContain("Share");
    }
  });

  // No "while it was live": a withdraw is allowed from `pending`, and a
  // rejection means it never was — so the line commits to nothing but the fact.
  it("uses the past tense, and neither 'yet' nor 'share', once closed", () => {
    for (const status of ["withdrawn", "hidden", "rejected"] as const) {
      const shown = renderEmpty(status);
      expect(shown).toContain("No one asked.");
      expect(shown).not.toContain("yet");
      expect(shown).not.toContain("Share");
    }
  });

  it("leaves no status without a line", () => {
    for (const status of LISTING_STATUSES) {
      expect(renderEmpty(status)).toMatch(/No one|Nobody/);
    }
  });
});

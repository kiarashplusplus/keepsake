/**
 * Issue #135's display half. The aspects have existed in `listing_aspects`
 * and on `PublicListing.aspects` since #36/#37 and no view rendered one —
 * which is a failure that nothing could catch, because every test asserted
 * on the data and none on the page. These assert on the page.
 */
import * as React from "react";
import { render } from "@testing-library/react-native";
import type { Aspect } from "@keepsake/contracts/photo";
import { AspectList } from "@/features/item/AspectList";

const SPOOL: Aspect[] = [
  { name: "brand", value: "KastKing" },
  { name: "material", value: "braided line" },
  { name: "size", value: "30 lbs 327 yds" },
];

describe("AspectList", () => {
  // `toJSON()`, not `getByText`: under `jest-expo/web` every `Text` renders
  // as a `div`, which RTL-RN's text queries do not match. The rest of this
  // suite reads the serialised tree for the same reason.
  it("shows every aspect's name and value", () => {
    const { toJSON } = render(<AspectList aspects={SPOOL} />);
    const json = JSON.stringify(toJSON());
    for (const aspect of SPOOL) {
      expect(json).toContain(aspect.name);
      expect(json).toContain(aspect.value);
    }
  });

  /**
   * The right number of aspects for a photo is often zero — the prompt is
   * told to return an empty array rather than guess. A heading, an empty
   * rail or a row of blank cells for that case would make a perfectly normal
   * listing look broken, so the component renders literally nothing.
   */
  it("renders nothing at all when the listing has no aspects", () => {
    const { toJSON } = render(<AspectList aspects={[]} />);
    expect(toJSON()).toBeNull();
  });

  it("keys on name AND value, so two aspects sharing a name both render", () => {
    const { toJSON } = render(
      <AspectList
        aspects={[
          { name: "colour", value: "blue" },
          { name: "colour", value: "cream" },
        ]}
      />,
    );
    const json = JSON.stringify(toJSON());
    expect(json).toContain("blue");
    expect(json).toContain("cream");
  });
});

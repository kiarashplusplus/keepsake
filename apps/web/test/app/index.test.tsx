import * as React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import type { PublicListing } from "@keepsake/contracts/listing";
import type { AspectShelf } from "@keepsake/contracts/shelves";
import { getFeed } from "@/api/feed";
import { getShelves } from "@/api/shelves";
import Feed from "../../app/index";

// `jest.mock` calls are hoisted above these imports by babel-plugin-jest-hoist,
// so writing the mocked modules' imports in normal top-of-file order still
// resolves to the mock (same pattern as test/app/give/*.test.tsx).
jest.mock("expo-router", () => {
  const ReactActual = jest.requireActual("react");
  return {
    useRouter: () => ({ setParams: jest.fn(), push: jest.fn(), replace: jest.fn() }),
    useLocalSearchParams: () => ({}),
    Link: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
      asChild ? children : ReactActual.createElement(ReactActual.Fragment, null, children),
  };
});

jest.mock("@/api/feed", () => ({ getFeed: jest.fn() }));
// Shelves (issue #39) are additive: every existing test in this file
// exercises the plain feed and should see no shelves at all, same as a
// catalogue where nothing clears the floor.
jest.mock("@/api/shelves", () => ({ getShelves: jest.fn().mockResolvedValue({ shelves: [], min_items: 3 }) }));

function makeListing(id: string, title: string, aspects: PublicListing["aspects"] = []): PublicListing {
  return {
    id,
    title,
    story: "My grandmother's hands made this cup every morning for forty years.",
    category: "other",
    place_name: "Somerville",
    admin1: "MA",
    country: "US",
    status: "approved",
    photos: [
      {
        id: `${id}-photo`,
        width: 800,
        height: 600,
        blurhash: "LKO2?U%2Tw=w]~RBVZRi};RPxuwH",
        url_full: "https://example.com/full.jpg",
        url_thumb: "https://example.com/thumb.jpg",
      },
    ],
    aspects,
    published_at: Date.now(),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

describe("Feed", () => {
  beforeEach(() => {
    window.localStorage.clear();
    jest.mocked(getFeed).mockReset();
    jest.mocked(getShelves).mockReset().mockResolvedValue({ shelves: [], min_items: 3 });
  });

  it("renders the first page from a mocked fetch and appends the next page on More", async () => {
    jest
      .mocked(getFeed)
      .mockResolvedValueOnce({ items: [makeListing("listing-1", "Brass compass")], next_cursor: "cursor-1" })
      .mockResolvedValueOnce({ items: [makeListing("listing-2", "Wool quilt")], next_cursor: null });

    const { toJSON, UNSAFE_getByProps } = render(<Feed />);

    await act(async () => {
      await flush();
    });

    expect(JSON.stringify(toJSON())).toContain("Brass compass");
    expect(jest.mocked(getFeed)).toHaveBeenCalledTimes(1);

    const moreButton = UNSAFE_getByProps({ accessibilityLabel: "More" });
    await act(async () => {
      fireEvent.press(moreButton);
      await flush();
    });

    expect(JSON.stringify(toJSON())).toContain("Wool quilt");
    // The first page's card is still there — appended, not replaced.
    expect(JSON.stringify(toJSON())).toContain("Brass compass");
    expect(jest.mocked(getFeed)).toHaveBeenCalledTimes(2);
  });

  it("shows the empty state with a Give button when there are no results", async () => {
    jest.mocked(getFeed).mockResolvedValueOnce({ items: [], next_cursor: null });

    const { toJSON } = render(<Feed />);

    await act(async () => {
      await flush();
    });

    expect(JSON.stringify(toJSON())).toContain("Nothing here yet. Be the first to give something.");
  });

  // Issue #40's guarantee, exercised at the point it's actually at risk: once
  // shelves (#39) exist on this same page, does a listing with zero aspects
  // — which by construction can never qualify for any shelf — still surface
  // in the plain grid underneath? A regression here would look exactly like
  // "shelves work great" in isolation while quietly turning the grid into a
  // shelf-only view for anyone who scrolls past the shelves.
  it("issue #40: a zero-aspect listing still renders in the main grid even when shelves exist and don't include it", async () => {
    const copperListing = makeListing("listing-copper", "Copper kettle", [{ name: "material", value: "copper" }]);
    const plainListing = makeListing("listing-plain", "A plain wooden spoon", []);

    jest.mocked(getFeed).mockResolvedValueOnce({ items: [copperListing, plainListing], next_cursor: null });
    const shelf: AspectShelf = { name: "material", value: "copper", count: 3, items: [copperListing] };
    jest.mocked(getShelves).mockReset().mockResolvedValueOnce({ shelves: [shelf], min_items: 3 });

    const { toJSON } = render(<Feed />);

    await act(async () => {
      await flush();
    });

    const tree = JSON.stringify(toJSON());
    // The shelf rendered...
    expect(tree).toContain("Copper kettle");
    // ...but the zero-aspect listing is not hidden because it has no shelf
    // to belong to — it's still in the full grid below.
    expect(tree).toContain("A plain wooden spoon");
  });
});

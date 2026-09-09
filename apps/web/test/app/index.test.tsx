import * as React from "react";
import { StyleSheet } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import type { PublicListing } from "@keepsake/contracts/listing";
import type { AspectShelf } from "@keepsake/contracts/shelves";
import { clearFeedCache } from "@/features/feed/useFeed";
import { getFeed } from "@/api/feed";
import { getShelves } from "@/api/shelves";
import { LOCATION_PREF_STORAGE_KEY } from "@/lib/geo";
import Feed from "../../app/index";

// `jest.mock` calls are hoisted above these imports by babel-plugin-jest-hoist,
// so writing the mocked modules' imports in normal top-of-file order still
// resolves to the mock (same pattern as test/app/give/*.test.tsx).
// Mutated per test to open the feed on a given URL (`/?q=…&postal=…`), which
// is how these tests reach a filtered or radius-limited feed without driving
// the debounced search box or the location controls. The `mock` name prefix
// is what lets babel-plugin-jest-hoist allow the reference from inside the
// hoisted factory below; it is only read at render time, long after this
// declaration has run.
const mockUrlParams: Record<string, string> = {};

jest.mock("expo-router", () => {
  const ReactActual = jest.requireActual("react");
  return {
    useRouter: () => ({ setParams: jest.fn(), push: jest.fn(), replace: jest.fn() }),
    useLocalSearchParams: () => mockUrlParams,
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

const DESKTOP_WIDTH = 1280;
const PHONE_WIDTH = 390;

/**
 * `useWindowDimensions()` is the switch behind every narrow-width decision on
 * this screen (issue #219's compact hero and collapsed location controls), so
 * these tests have to be able to move it.
 *
 * react-native-web's `Dimensions` reads `document.documentElement.clientWidth`
 * and refreshes only on a `resize` event — and jsdom, which lays nothing out,
 * reports that width as **0**. Left alone, every render test in this file
 * would silently be a 0px-wide phone. Defining the property and dispatching
 * `resize` before render is enough: `Dimensions` registered its window
 * listener at import time, and `useWindowDimensions` re-reads on mount.
 */
function setViewportWidth(width: number): void {
  Object.defineProperty(window.document.documentElement, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(window.document.documentElement, "clientHeight", { configurable: true, value: 844 });
  window.dispatchEvent(new Event("resize"));
}

describe("Feed", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // `useFeed` caches page 1 of a query in module state for a minute, so a
    // list fetched by the case above is still there for the case below —
    // which would then render listings its own mock never returned, and pass
    // for the wrong reason (or, as it did first, fail confusingly).
    clearFeedCache();
    for (const key of Object.keys(mockUrlParams)) delete mockUrlParams[key];
    setViewportWidth(DESKTOP_WIDTH);
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

  // --- Issue #220: three empty states, not one --------------------------

  it("issue #220: a search that matches nothing says so, and Clear search really clears it", async () => {
    mockUrlParams.q = "zzzznothingmatchesthis";
    jest
      .mocked(getFeed)
      .mockResolvedValueOnce({ items: [], next_cursor: null })
      .mockResolvedValueOnce({ items: [makeListing("listing-1", "Brass compass")], next_cursor: null });

    const { toJSON, UNSAFE_getByProps } = render(<Feed />);
    await act(async () => {
      await flush();
    });

    const empty = JSON.stringify(toJSON());
    expect(empty).toContain("Nothing matches");
    expect(empty).toContain("zzzznothingmatchesthis");
    // The bug this issue is about: the empty-marketplace copy, and a button
    // offering the one action that cannot find what the visitor searched for.
    expect(empty).not.toContain("Nothing here yet. Be the first to give something.");

    await act(async () => {
      fireEvent.press(UNSAFE_getByProps({ accessibilityLabel: "Clear search" }));
      await flush();
    });

    // Really cleared: a fresh fetch with no `q`, and the results are back.
    expect(jest.mocked(getFeed).mock.calls[1]?.[0]).not.toHaveProperty("q");
    expect(JSON.stringify(toJSON())).toContain("Brass compass");
  });

  it("issue #220: a radius with nothing in it offers to widen, and the widening persists", async () => {
    mockUrlParams.country = "US";
    mockUrlParams.postal = "02144";
    mockUrlParams.radius_mi = "25";
    jest
      .mocked(getFeed)
      .mockResolvedValueOnce({ items: [], next_cursor: null })
      .mockResolvedValueOnce({ items: [makeListing("listing-1", "Brass compass")], next_cursor: null });

    const { toJSON, UNSAFE_getByProps } = render(<Feed />);
    await act(async () => {
      await flush();
    });

    expect(JSON.stringify(toJSON())).toContain("Nothing within 25 mi of 02144 yet.");

    await act(async () => {
      fireEvent.press(UNSAFE_getByProps({ accessibilityLabel: "Widen to 50 mi" }));
      await flush();
    });

    expect(jest.mocked(getFeed).mock.calls[1]?.[0]).toMatchObject({ postal: "02144", radius_mi: 50 });
    // `LocationBar` persists every location change it makes; a change made
    // from the empty state has to persist identically or it silently reverts
    // on the next visit.
    const stored = window.localStorage.getItem(LOCATION_PREF_STORAGE_KEY);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored as string)).toMatchObject({ radius: 50 });
  });

  // --- Issue #219: what the first screenful holds on a phone -------------

  it("issue #219: the hero keeps its deck and CTA at desktop width", async () => {
    jest.mocked(getFeed).mockResolvedValueOnce({ items: [], next_cursor: null });

    const { toJSON } = render(<Feed />);
    await act(async () => {
      await flush();
    });

    expect(JSON.stringify(toJSON())).toContain("Some things are too full of memory to sell");
  });

  /**
   * Issue #219's two narrow-width behaviours — a hero cut down to its
   * headline, and location controls folded behind a summary — used to be JS
   * branches on `useWindowDimensions()`, and these tests moved jsdom's width
   * to drive them. They are CSS's decision now, because one static export is
   * served to every viewport and a JS branch bakes the build's width into it
   * (`packages/tokens/src/breakpoints.ts`).
   *
   * So what jsdom can still prove is what these assert: both branches are in
   * the markup, each carrying the `display` variable that decides it, and the
   * phone's toggle still opens the controls. **Whether the right one is
   * actually on screen at a given width is not assertable here** — jsdom
   * resolves no media queries and lays nothing out. That half lives in
   * `e2e/browse.spec.ts` and `e2e/staticRender.spec.ts`, which run in a real
   * browser in both the `mobile` and `desktop` projects, and which is where
   * this bug would have been caught.
   */
  it("issue #219: the hero deck ships at every width, behind the wide-only switch", async () => {
    setViewportWidth(PHONE_WIDTH);
    jest.mocked(getFeed).mockResolvedValueOnce({ items: [], next_cursor: null });

    const { toJSON, UNSAFE_getByProps } = render(<Feed />);
    await act(async () => {
      await flush();
    });

    expect(JSON.stringify(toJSON())).toContain("Give a keepsake a second life.");
    // The deck restates `/welcome`, and the header already carries a `Give`
    // button at this width — between them they were most of the reason the
    // first keepsake sat below the fold. It is in the markup either way now;
    // below the breakpoint the stylesheet is what takes it off screen.
    const deck = UNSAFE_getByProps({ testID: "feed-hero-deck" });
    expect(StyleSheet.flatten(deck.props.style)).toMatchObject({ display: "var(--ks-wide-only, none)" });
  });

  it("issue #219: the phone's location summary opens the controls it stands in for", async () => {
    setViewportWidth(PHONE_WIDTH);
    jest.mocked(getFeed).mockResolvedValue({ items: [makeListing("listing-1", "Brass compass")], next_cursor: null });

    const { UNSAFE_getByProps } = render(<Feed />);
    await act(async () => {
      await flush();
    });

    // Collapsed: the summary states the choice in force, and the four rows of
    // controls it stands in for are behind the wide-only switch — present in
    // the markup, off screen below the breakpoint.
    const toggle = UNSAFE_getByProps({ accessibilityLabel: "Near · anywhere. Change where you are looking" });
    expect(toggle.props.accessibilityState).toEqual({ expanded: false });
    expect(StyleSheet.flatten(UNSAFE_getByProps({ testID: "feed-location-controls" }).props.style)).toMatchObject({
      display: "var(--ks-wide-only, none)",
    });

    await act(async () => {
      fireEvent.press(toggle);
      await flush();
    });

    // Expanded drops the switch entirely, so the controls are on screen at
    // every width rather than at one of them.
    expect(StyleSheet.flatten(UNSAFE_getByProps({ testID: "feed-location-controls" }).props.style)).not.toHaveProperty("display");
    expect(UNSAFE_getByProps({ accessibilityLabel: "Use my location" })).not.toBeNull();
    expect(UNSAFE_getByProps({ accessibilityLabel: "Near · anywhere. Hide the location controls" }).props.accessibilityState).toEqual({
      expanded: true,
    });
  });

  it("issue #219: the summary row itself is the narrow-only half", async () => {
    jest.mocked(getFeed).mockResolvedValueOnce({ items: [], next_cursor: null });

    const { UNSAFE_getByProps } = render(<Feed />);
    await act(async () => {
      await flush();
    });

    // The disclosure button is rendered at every width and hidden above the
    // breakpoint, where the controls below it are always open. Its style is a
    // function of the press state, hence calling it.
    const toggle = UNSAFE_getByProps({ accessibilityLabel: "Near · anywhere. Change where you are looking" });
    expect(StyleSheet.flatten(toggle.props.style({ pressed: false }))).toMatchObject({ display: "var(--ks-narrow-only, flex)" });
  });
});

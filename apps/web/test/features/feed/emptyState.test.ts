import { CATEGORY_LABELS } from "@keepsake/contracts/listing";
import { describeLocationChoice, radiusIsActive, resolveFeedEmptyState, widerRadius } from "@/features/feed/emptyState";
import { DEFAULT_LOCATION_PREF, type LocationPref } from "@/lib/geo";

/** No postcode, no coordinates: the 25 mi in `DEFAULT_LOCATION_PREF` has
 * nothing to measure from, so it filters nothing. */
const unanchored: LocationPref = DEFAULT_LOCATION_PREF;
const near02144: LocationPref = { ...DEFAULT_LOCATION_PREF, mode: "postal", postal: "02144", radius: 25 };
const nearCoords: LocationPref = { ...DEFAULT_LOCATION_PREF, mode: "coords", postal: "", lat: 42.39, lng: -71.12, radius: 10 };

describe("radiusIsActive", () => {
  // The rule has to agree with `buildFeedQuery`'s geo branch — a radius the
  // API was never told about narrows nothing, and offering to widen it would
  // be a button that changes state and changes no results.
  it.each([
    ["a postcode and a radius", near02144, true],
    ["coordinates and a radius", nearCoords, true],
    ["a radius with nothing to anchor it", unanchored, false],
    ["a postcode with the radius set to anywhere", { ...near02144, radius: "anywhere" } as LocationPref, false],
    ["postal mode with a blank postcode", { ...near02144, postal: "   " } as LocationPref, false],
    ["coords mode with no fix yet", { ...nearCoords, lat: null, lng: null } as LocationPref, false],
  ])("%s", (_name, location, expected) => {
    expect(radiusIsActive(location)).toBe(expected);
  });
});

describe("describeLocationChoice", () => {
  it("names the postcode, the coordinates, or says anywhere", () => {
    expect(describeLocationChoice(near02144)).toBe("25 mi of 02144");
    expect(describeLocationChoice(nearCoords)).toBe("10 mi of your location");
    expect(describeLocationChoice(unanchored)).toBe("anywhere");
    expect(describeLocationChoice({ ...near02144, radius: "anywhere" })).toBe("anywhere");
  });
});

describe("widerRadius", () => {
  it("steps out one option at a time and ends at anywhere", () => {
    expect(widerRadius(10)).toBe(25);
    expect(widerRadius(25)).toBe(50);
    expect(widerRadius(50)).toBe(100);
    expect(widerRadius(100)).toBe("anywhere");
    expect(widerRadius("anywhere")).toBeNull();
  });
});

describe("resolveFeedEmptyState (issue #220)", () => {
  it("an unfiltered, unlocated empty feed keeps the original invitation", () => {
    const state = resolveFeedEmptyState({ q: "", category: null, location: unanchored });

    expect(state.kind).toBe("catalogue");
    expect(state.title).toBe("Nothing here yet. Be the first to give something.");
    expect(state.stamp).toBe("Empty");
    expect(state.actions).toEqual([{ kind: "give", label: "Give something" }]);
  });

  it("a search that matches nothing names the search and offers to clear it", () => {
    const state = resolveFeedEmptyState({ q: "zzzznothingmatchesthis", category: null, location: unanchored });

    expect(state.kind).toBe("filtered");
    expect(state.title).toBe("Nothing matches “zzzznothingmatchesthis”.");
    expect(state.actions).toEqual([{ kind: "clearSearch", label: "Clear search" }]);
  });

  // The heart of #220: the marketplace is not empty, the visitor typed a word
  // that matches none of it, and "Give something" is the one action that
  // cannot possibly help. If this ever comes back, it comes back here first.
  it("never offers Give when filters are what emptied the page", () => {
    const searched = resolveFeedEmptyState({ q: "brooch", category: null, location: unanchored });
    const categorised = resolveFeedEmptyState({ q: "", category: "jewelry_watches", location: near02144 });

    for (const state of [searched, categorised]) {
      expect(state.actions.map((action) => action.kind)).not.toContain("give");
      expect(state.title).not.toBe("Nothing here yet. Be the first to give something.");
    }
  });

  it("a category with no matches names the category", () => {
    const state = resolveFeedEmptyState({ q: "", category: "music_instruments", location: unanchored });

    expect(state.title).toBe(`Nothing in ${CATEGORY_LABELS.music_instruments} right now.`);
    expect(state.actions).toEqual([{ kind: "clearCategory", label: "All categories" }]);
  });

  it("offers all three escapes when a search, a category and a radius are all on", () => {
    const state = resolveFeedEmptyState({ q: "brooch", category: "jewelry_watches", location: near02144 });

    expect(state.title).toBe(`Nothing in ${CATEGORY_LABELS.jewelry_watches} matches “brooch”.`);
    expect(state.line).toContain("25 mi of 02144");
    expect(state.actions).toEqual([
      { kind: "clearSearch", label: "Clear search" },
      { kind: "clearCategory", label: "All categories" },
      { kind: "widenRadius", label: "Widen to 50 mi", radius: 50 },
    ]);
  });

  it("a radius with nothing in it is its own case, and the widen button really widens", () => {
    const state = resolveFeedEmptyState({ q: "", category: null, location: near02144 });

    expect(state.kind).toBe("radius");
    expect(state.stamp).toBe("Too far");
    expect(state.title).toBe("Nothing within 25 mi of 02144 yet.");
    expect(state.actions[0]).toEqual({ kind: "widenRadius", label: "Widen to 50 mi", radius: 50 });
    // Giving is still a sensible second offer here — an empty neighbourhood
    // is exactly where being the first one matters — but it is no longer the
    // only thing on offer.
    expect(state.actions[1]).toEqual({ kind: "give", label: "Give something" });
  });

  it("says 'your location' rather than a postcode when the fix came from the browser", () => {
    const state = resolveFeedEmptyState({ q: "", category: null, location: nearCoords });

    expect(state.title).toBe("Nothing within 10 mi of your location yet.");
  });

  it("the widest radius escapes to anywhere rather than dead-ending", () => {
    const state = resolveFeedEmptyState({ q: "", category: null, location: { ...near02144, radius: 100 } });

    expect(state.actions[0]).toEqual({ kind: "widenRadius", label: "Search anywhere", radius: "anywhere" });
  });

  it("a selected radius with no postcode behind it is the empty-marketplace case, not the radius one", () => {
    const state = resolveFeedEmptyState({ q: "", category: null, location: { ...unanchored, radius: 10 } });

    expect(state.kind).toBe("catalogue");
    expect(state.actions.map((action) => action.kind)).not.toContain("widenRadius");
  });
});

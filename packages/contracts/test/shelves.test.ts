import { describe, expect, it } from "vitest";
import { AspectShelf, ShelvesResponse } from "../src/shelves";

const VALID_LISTING = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  title: "A quiet teacup",
  story: "This was my grandmother's favorite teacup.",
  category: "home_kitchen",
  place_name: "Somerville",
  admin1: "MA",
  country: "US",
  status: "approved",
  photos: [],
  published_at: 1_700_000_000_000,
};

describe("AspectShelf / ShelvesResponse", () => {
  it("accepts a shelf carrying zero or more listings", () => {
    const shelf = { name: "material", value: "copper", count: 3, items: [VALID_LISTING] };
    expect(AspectShelf.safeParse(shelf).success).toBe(true);
  });

  it("a listing inside a shelf still defaults aspects to [] like any other PublicListing", () => {
    const result = AspectShelf.safeParse({ name: "material", value: "copper", count: 1, items: [VALID_LISTING] });
    expect(result.success).toBe(true);
    expect(result.data?.items[0]?.aspects).toEqual([]);
  });

  it("rejects a negative count", () => {
    expect(AspectShelf.safeParse({ name: "material", value: "copper", count: -1, items: [] }).success).toBe(false);
  });

  it("a ShelvesResponse with no shelves is valid — the no-shelf-clears-the-floor case", () => {
    const result = ShelvesResponse.safeParse({ shelves: [], min_items: 3 });
    expect(result.success).toBe(true);
    expect(result.data?.shelves).toEqual([]);
  });
});

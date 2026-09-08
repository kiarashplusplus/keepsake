import type { OwnerListing } from "@keepsake/contracts/listing";
import { LISTING_GROUP_ORDER, groupListings } from "@/features/mine/groupListings";

function makeListing(overrides: Partial<OwnerListing>): OwnerListing {
  return {
    id: "01AAAAAAAAAAAAAAAAAAAAAAAA",
    title: "A mug",
    story: "A story about a mug that is definitely long enough to pass validation.",
    category: "home_kitchen",
    place_name: "Somerville",
    admin1: "MA",
    country: "US",
    postal_code: "02144",
    status: "pending",
    photos: [],
    aspects: [],
    published_at: 0,
    moderation_reason: null,
    request_count: 0,
    chosen_request_id: null,
    version: 1,
    created_at: 0,
    updated_at: 0,
    held: false,
    category_chosen_at: null,
    ...overrides,
  };
}

describe("groupListings", () => {
  it("buckets every status into its dashboard group", () => {
    const listings = [
      makeListing({ id: "1", status: "pending" }),
      makeListing({ id: "2", status: "needs_review" }),
      makeListing({ id: "3", status: "approved" }),
      makeListing({ id: "4", status: "rejected" }),
      makeListing({ id: "5", status: "hidden" }),
      makeListing({ id: "6", status: "given" }),
      makeListing({ id: "7", status: "withdrawn" }),
    ];

    const groups = groupListings(listings);

    expect(groups.reviewing.map((l) => l.id)).toEqual(["1", "2"]);
    expect(groups.live.map((l) => l.id)).toEqual(["3"]);
    expect(groups.needs_attention.map((l) => l.id)).toEqual(["4", "5"]);
    expect(groups.given.map((l) => l.id)).toEqual(["6"]);
    expect(groups.withdrawn.map((l) => l.id)).toEqual(["7"]);
  });

  it("exposes the five groups in dashboard display order", () => {
    expect(LISTING_GROUP_ORDER).toEqual(["reviewing", "live", "needs_attention", "given", "withdrawn"]);
  });

  it("returns an empty array (not undefined) for a group with no listings", () => {
    const groups = groupListings([]);
    for (const key of LISTING_GROUP_ORDER) {
      expect(groups[key]).toEqual([]);
    }
  });
});

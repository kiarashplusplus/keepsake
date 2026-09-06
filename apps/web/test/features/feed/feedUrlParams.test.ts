import { feedQueryFromUrlParams, urlParamsFromFeedQuery, type FeedUrlQuery } from "@/features/feed/feedUrlParams";

describe("feed URL params round trip", () => {
  const cases: FeedUrlQuery[] = [
    { q: "grandmother", category: "photos_art_handmade", country: "US", postal: "02144", radius_mi: 25 },
    { category: "other" },
    { country: "GB", postal: "SW1A", radius_mi: 100 },
    {},
  ];

  it.each(cases)("params -> FeedQuery -> params reproduces the same query for %j", (query) => {
    const params = urlParamsFromFeedQuery(query);
    const roundTripped = feedQueryFromUrlParams(params);
    expect(roundTripped).toEqual(query);
  });

  it("drops an invalid category/country/radius rather than throwing", () => {
    const result = feedQueryFromUrlParams({ category: "not_a_category", country: "FR", radius_mi: "17" });
    expect(result).toEqual({});
  });

  it("takes the first value of an array param", () => {
    const result = feedQueryFromUrlParams({ q: ["first", "second"] });
    expect(result.q).toBe("first");
  });

  it("drops an empty string rather than reflecting it", () => {
    expect(feedQueryFromUrlParams({ q: "" })).toEqual({});
  });
});

import { describe, expect, it } from "vitest";
import { FeedQuery, RADIUS_OPTIONS } from "../src/feed";

describe("FeedQuery", () => {
  it("defaults limit and allows an empty query", () => {
    const result = FeedQuery.safeParse({});
    expect(result.success).toBe(true);
    expect(result.data?.limit).toBe(24);
  });

  it("accepts a valid radius option", () => {
    expect(FeedQuery.safeParse({ radius_mi: 25 }).success).toBe(true);
  });

  it("rejects a radius that is not one of the fixed options", () => {
    expect(FeedQuery.safeParse({ radius_mi: 30 }).success).toBe(false);
  });

  it("exposes the four radius options", () => {
    expect(RADIUS_OPTIONS).toEqual([10, 25, 50, 100]);
  });
});

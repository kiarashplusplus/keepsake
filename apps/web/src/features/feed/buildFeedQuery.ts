/**
 * Turns the feed screen's UI state (category, search text, location
 * preference) into the `FeedQueryInput` `src/api/feed.ts` sends. Kept pure
 * and separate from `useFeed`/`app/index.tsx` so the mode-selection rule is
 * unit-testable without rendering anything: category and search always
 * combine with whatever location mode is active (per the plan, "Category
 * combines with any mode"); a postcode and coordinates are mutually
 * exclusive (the API takes one or the other); and "Anywhere" clears location
 * filtering entirely rather than mapping to any single `radius_mi` value,
 * since `RADIUS_OPTIONS` has no "no limit" member of its own — see the task
 * report's contract-gap note.
 */
import type { Category } from "@keepsake/contracts/listing";
import type { FeedQueryInput } from "@/api/feed";
import type { LocationPref } from "@/lib/geo";

export type BuildFeedQueryInput = {
  category: Category | null;
  q: string;
  location: LocationPref;
  limit?: number;
};

export function buildFeedQuery({ category, q, location, limit }: BuildFeedQueryInput): FeedQueryInput {
  const query: FeedQueryInput = {};

  if (category !== null) query.category = category;

  const trimmedQ = q.trim();
  if (trimmedQ !== "") query.q = trimmedQ;

  if (location.radius !== "anywhere") {
    if (location.mode === "coords" && location.lat !== null && location.lng !== null) {
      query.lat = location.lat;
      query.lng = location.lng;
      query.radius_mi = location.radius;
    } else if (location.mode === "postal" && location.postal.trim() !== "") {
      query.country = location.country;
      query.postal = location.postal.trim();
      query.radius_mi = location.radius;
    }
  }

  if (limit !== undefined) query.limit = limit;

  return query;
}

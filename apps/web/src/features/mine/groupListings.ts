/**
 * Pure grouping of the owner's listings into the dashboard's five buckets
 * (Reviewing / Live / Needs attention / Given / Withdrawn — see the build
 * plan's "Dashboard" section), kept separate from `app/mine/index.tsx` so
 * the status-to-bucket mapping is unit-testable against a fixture without
 * rendering anything.
 */
import type { ListingStatus, OwnerListing } from "@keepsake/contracts/listing";

export type ListingGroupKey = "reviewing" | "live" | "needs_attention" | "given" | "withdrawn";

export const LISTING_GROUP_ORDER: readonly ListingGroupKey[] = ["reviewing", "live", "needs_attention", "given", "withdrawn"];

export const LISTING_GROUP_LABELS: Record<ListingGroupKey, string> = {
  reviewing: "Reviewing",
  live: "Live",
  needs_attention: "Needs attention",
  given: "Given",
  withdrawn: "Withdrawn",
};

export type GroupedListings<T extends Groupable = OwnerListing> = Record<ListingGroupKey, T[]>;

/** The only field grouping reads. Generic over it (rather than over
 * `OwnerListing` itself) so the dashboard's richer `OwnerDashboardListing`
 * groups without a cast and without this file knowing what staleness is. */
export type Groupable = { status: ListingStatus };

function groupKeyFor(status: ListingStatus): ListingGroupKey {
  switch (status) {
    case "pending":
    case "needs_review":
      return "reviewing";
    case "approved":
      return "live";
    case "rejected":
    case "hidden":
      return "needs_attention";
    case "given":
      return "given";
    case "withdrawn":
      return "withdrawn";
  }
}

export function groupListings<T extends Groupable>(listings: readonly T[]): GroupedListings<T> {
  const groups: GroupedListings<T> = { reviewing: [], live: [], needs_attention: [], given: [], withdrawn: [] };
  for (const listing of listings) {
    groups[groupKeyFor(listing.status)].push(listing);
  }
  return groups;
}

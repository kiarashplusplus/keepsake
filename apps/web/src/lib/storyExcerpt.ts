/**
 * Moved to `@keepsake/contracts/story` when the share-card renderer needed the
 * same rule: a keepsake's story has to read identically in the feed and in the
 * link preview a friend sees, and two copies of a truncation rule is how that
 * quietly stops being true. Re-exported here so this module's existing call
 * sites (`features/feed/ListingCard.tsx`) are unchanged.
 */
export { storyExcerpt } from "@keepsake/contracts/story";

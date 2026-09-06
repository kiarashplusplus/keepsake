/** Event name constants for `track()`. Add here rather than inlining
 * strings at call sites, so a rename is one edit instead of a grep-and-pray. */
export const AnalyticsEvents = {
  FeedViewed: "feed_viewed",
  ListingViewed: "listing_viewed",
  GiveStarted: "give_started",
  GiveSubmitted: "give_submitted",
  RequestSent: "request_sent",
} as const;

export type AnalyticsEventName = (typeof AnalyticsEvents)[keyof typeof AnalyticsEvents];

/** Event name constants for `track()`. Add here rather than inlining
 * strings at call sites, so a rename is one edit instead of a grep-and-pray. */
export const AnalyticsEvents = {
  FeedViewed: "feed_viewed",
  ItemViewed: "item_viewed",
  GiveStarted: "give_started",
  GivePhotoUploaded: "give_photo_uploaded",
  GiveSubmitted: "give_submitted",
  GiveLive: "give_live",
  GiveRejected: "give_rejected",
  RequestSent: "request_sent",
  ReportSent: "report_sent",
  Chosen: "chosen",
  RecoverRequested: "recover_requested",
  Recovered: "recovered",
} as const;

export type AnalyticsEventName = (typeof AnalyticsEvents)[keyof typeof AnalyticsEvents];

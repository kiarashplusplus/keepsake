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
  // Issue #188: `RequestSent` fires when the form is submitted, which is no
  // longer the moment the giver hears about it — `RequestConfirmed` is. Two
  // events rather than a moved one, because the gap between them is the
  // number this change is answerable for: how many people stop at the
  // confirm step.
  RequestSent: "request_sent",
  RequestConfirmed: "request_confirmed",
  ReportSent: "report_sent",
  Chosen: "chosen",
  RecoverRequested: "recover_requested",
  Recovered: "recovered",
  RequestWithdrawn: "request_withdrawn",
} as const;

export type AnalyticsEventName = (typeof AnalyticsEvents)[keyof typeof AnalyticsEvents];

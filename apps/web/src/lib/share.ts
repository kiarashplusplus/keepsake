/**
 * `navigator.share` when available (mobile browsers, some desktop), else
 * clipboard. Callers show a toast on `"copied"`/`"failed"`; `"shared"` needs
 * no follow-up (the OS share sheet is the confirmation).
 *
 * ## Why this shares a URL and not the card image
 *
 * The designed share card (`apps/api/src/routes/ogCard.ts`) reaches the
 * recipient through the link's *unfurl*, not as an attachment. Web Share
 * Level 2 can attach files, and it was considered — but iOS Safari and
 * several Android targets drop the `url` when `files` is present, which would
 * trade a tappable link for a picture of one. A link that unfurls into the
 * card is the same image plus a way to reach the keepsake, and it works in
 * every messaging app rather than the subset that implements Level 2.
 */
import { config } from "@/lib/config";
import { track } from "@/lib/analytics";
import { AnalyticsEvents } from "@/lib/analyticsEvents";

/** Where the share was initiated from — the giver's own "It's live." screen,
 * or a keepsake's public page (which may be anyone's). */
export type ShareSurface = "give_review" | "item";
export type ShareListingInput = { id: string; title: string; surface: ShareSurface };
export type ShareResult = "shared" | "cancelled" | "copied" | "failed";

function listingUrl(id: string): string {
  const origin = config.siteUrl || (typeof window !== "undefined" ? window.location.origin : "");
  return `${origin}/item/${id}`;
}

/**
 * The message body. One clause, then the URL.
 *
 * `text` used to be the bare title, which reads as a fragment in a chat
 * bubble ("Grandmother's teacup" and nothing else). Kept deliberately short
 * all the same: some share targets concatenate `text` and `url` into a
 * length-limited field and drop the `url` when the result is too long, and
 * the URL is the part that matters — it is what unfurls into the card.
 */
export function shareText(title: string): string {
  return `${title} — free to a good home on Keepsake.`;
}

export async function shareListing({ id, title, surface }: ShareListingInput): Promise<ShareResult> {
  const url = listingUrl(id);
  const result = await attemptShare(url, title);
  // Fired here, not at the two call sites: a third caller cannot forget it,
  // and `result` records the outcome including "cancelled", which is the
  // interesting one (a share sheet opened and then dismissed is a different
  // signal from a share that never started). `track` is consent-gated and
  // no-ops when analytics are not allowed.
  track(AnalyticsEvents.Shared, { id, surface, result });
  return result;
}

async function attemptShare(url: string, title: string): Promise<ShareResult> {
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      await navigator.share({ title, text: shareText(title), url });
      return "shared";
    } catch (error) {
      // AbortError means the user dismissed the share sheet — that's not a
      // failure worth falling back to clipboard for.
      if (error instanceof Error && error.name === "AbortError") return "cancelled";
      // Any other share failure falls through to the clipboard attempt below.
    }
  }

  if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(url);
      return "copied";
    } catch {
      return "failed";
    }
  }

  return "failed";
}

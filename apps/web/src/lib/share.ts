/**
 * `navigator.share` when available (mobile browsers, some desktop), else
 * clipboard. Callers show a toast on `"copied"`/`"failed"`; `"shared"` needs
 * no follow-up (the OS share sheet is the confirmation).
 */
import { config } from "@/lib/config";

export type ShareListingInput = { id: string; title: string };
export type ShareResult = "shared" | "cancelled" | "copied" | "failed";

function listingUrl(id: string): string {
  const origin = config.siteUrl || (typeof window !== "undefined" ? window.location.origin : "");
  return `${origin}/item/${id}`;
}

export async function shareListing({ id, title }: ShareListingInput): Promise<ShareResult> {
  const url = listingUrl(id);

  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      await navigator.share({ title, text: title, url });
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

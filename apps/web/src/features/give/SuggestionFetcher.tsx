/**
 * Fetches an AI suggestion for the give flow's current cover photo, once
 * per photo id, and hands it to the reducer via `set_suggestion` — never
 * applying anything to the form itself here (see `giveDraft.ts`'s reducer
 * case for why the pre-fill has to happen there, not in an effect).
 *
 * Mounted in `app/give/_layout.tsx`, staying mounted across all five steps:
 * the request is fired the moment a photo finishes uploading (step 1) and
 * its result is still there by the time the giver reaches details/story,
 * without needing to re-fire it per step or thread a prop through the
 * `<Stack>`.
 *
 * Skips entirely once `draft.listingId` is set (#290) — a give flow with a
 * `listingId` is either mid-`?edit=` (the cover photo already belongs to a
 * published listing, whose title `useEditHydration` marks `titleDirty` for
 * exactly this reason) or resubmitting after rejection, and neither wants a
 * *fresh* vision call quietly relabelling the listing's category out from
 * under the giver. It also stops the flow from spending `SUGGEST` budget on
 * every edit-open for a suggestion nothing downstream will use.
 */
import * as React from "react";
import { useGiveDraft } from "@/features/give/GiveDraftContext";
import { coverPhoto } from "@/features/give/giveDraft";
import { suggestPhoto } from "@/api/photos";

export function SuggestionFetcher(): null {
  const { draft, dispatch } = useGiveDraft();
  const coverId = draft.listingId === null ? (coverPhoto(draft)?.id ?? null) : null;
  const hasSuggestion = coverId !== null && draft.suggestions[coverId] !== undefined;
  // Tracks ids already requested (in flight or done) so a re-render between
  // the request firing and its response landing doesn't fire a duplicate —
  // `hasSuggestion` alone only rules out the "already landed" half of that.
  const attemptedRef = React.useRef<Set<string>>(new Set());

  React.useEffect(() => {
    if (coverId === null || hasSuggestion || attemptedRef.current.has(coverId)) return undefined;
    attemptedRef.current.add(coverId);

    let cancelled = false;
    suggestPhoto(coverId)
      .then((suggestion) => {
        if (cancelled || suggestion === null) return;
        dispatch({ type: "set_suggestion", photoId: coverId, suggestion });
      })
      .catch(() => {
        // Autofill is a nice-to-have; a failed request just leaves the form
        // exactly as usable as if suggestions didn't exist. Not retried
        // automatically — `attemptedRef` intentionally doesn't get cleared
        // here, matching the endpoint's own "never a second vision call for
        // a cheap retry" posture.
      });

    return () => {
      cancelled = true;
    };
  }, [coverId, hasSuggestion, dispatch]);

  return null;
}

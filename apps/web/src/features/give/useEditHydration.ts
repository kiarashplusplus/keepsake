/**
 * When the URL carries `?edit=<listingId>` (the dashboard's Edit action —
 * see `app/mine/[id].tsx`), fetches that listing once and hydrates the give
 * draft from it so the give flow re-opens pre-filled.
 *
 * Two other jobs live here now, both about the draft's lifecycle rather
 * than the fetch itself:
 *
 * - **#281**: `?edit=` only ever appears in the URL on this flow's first
 *   step (every later `router.push` inside the flow drops the query
 *   string), so "was this flow entered to edit something" has to be decided
 *   once, at mount, and remembered for the life of this mounted layout — not
 *   re-derived from the live search params on every render, which would
 *   read as "left the edit" the moment the giver advances past step 1.
 *   `editTargetOnce` is that one-time decision. Symmetrically: a flow
 *   entered with **no** `?edit=` at all must not inherit a `listingId` left
 *   in `sessionStorage` by an edit the giver opened and then abandoned —
 *   otherwise the next "Give" in this tab silently PATCHes (or has its
 *   photos deleted from) someone else's listing. `initialListingIdRef`
 *   captures the draft's `listingId` at that same mount, once, so a
 *   `listingId` this flow legitimately assigns later (a fresh create, or a
 *   rejected listing's resubmit) can never retroactively trigger the reset.
 * - **#289**: nothing else in the give flow knew the prefill fetch was in
 *   flight, so without `hydrating` a giver on a slow connection could start
 *   typing or add a photo into a form the fetch was about to overwrite
 *   wholesale. `app/give/_layout.tsx` reads this to hold every step's UI
 *   back until it resolves (or fails).
 *
 * Known gap: `OwnerListing` (the API's response shape) doesn't round-trip
 * the raw postal code the giver originally typed — only the resolved
 * `place_name`/`admin1` it geocoded to. `@keepsake/contracts` is owned by
 * the sibling agent building the API in this milestone, so rather than
 * editing it, the postcode field comes back empty here and the giver
 * re-enters it on the details step (which then re-resolves and shows the
 * same place name). Worth a `postal_code` field on `OwnerListing` in a
 * follow-up.
 */
import * as React from "react";
import { useGlobalSearchParams } from "expo-router";
import { getMyListing } from "@/api/me";
import { useGiveDraft } from "@/features/give/GiveDraftContext";
import { GIVE_DRAFT_INITIAL, type GiveDraft } from "@/features/give/giveDraft";

export type EditHydrationState = {
  /** True from mount until the `?edit=` fetch this flow was opened with
   * resolves or fails — always `false` when the flow wasn't opened with
   * `?edit=` at all. */
  hydrating: boolean;
};

export function useEditHydration(): EditHydrationState {
  const { edit } = useGlobalSearchParams<{ edit?: string }>();
  const { draft, dispatch } = useGiveDraft();

  // Decided once, from whatever the URL carried the moment this layout
  // mounted — see the header comment's #281 note on why this can't track
  // the live search params across the flow's later steps.
  const [editTargetOnce] = React.useState<string | null>(() => (typeof edit === "string" && edit.length > 0 ? edit : null));
  // The draft's `listingId` at that same mount — read once, inside the
  // effect below rather than a `useState` initializer, since a ref must
  // never be read during render (`react-hooks/refs`). Fixed for the life of
  // this hook either way, so a `listingId` this flow assigns *itself*
  // afterwards (a create that just succeeded, a rejected listing queued for
  // resubmit) never re-triggers the fresh-entry reset below.
  const initialListingIdRef = React.useRef(draft.listingId);
  // Set once the `?edit=` fetch below has resolved or failed — the async
  // half of `hydrating`, which a plain `editTargetOnce !== draft.listingId`
  // comparison can't express on its own (a failed fetch never sets
  // `listingId`, so that comparison alone would call it "still hydrating"
  // forever). Only ever set from the `.finally()` below, not synchronously
  // in the effect body — see `details.tsx`'s note on
  // `react-hooks/set-state-in-effect` for why that split matters.
  const [settled, setSettled] = React.useState(false);
  const hydrating = editTargetOnce !== null && editTargetOnce !== draft.listingId && !settled;

  React.useEffect(() => {
    if (editTargetOnce === null) {
      // Entered fresh, not to edit anything. A `listingId` already sitting
      // in the draft at that moment can only be left over from an edit the
      // giver opened in this tab and never submitted — clear the whole
      // prefill (photos, story, title included, not just the id) so this
      // give starts from nothing rather than quietly targeting that
      // listing (#281).
      if (initialListingIdRef.current !== null) dispatch({ type: "reset" });
      return undefined;
    }
    if (editTargetOnce === draft.listingId) return undefined;

    let cancelled = false;
    getMyListing(editTargetOnce)
      .then((detail) => {
        if (cancelled) return;
        const hydrated: GiveDraft = {
          ...GIVE_DRAFT_INITIAL,
          photos: detail.photos.map((photo) => ({
            clientId: photo.id,
            id: photo.id,
            objectUrl: null,
            width: photo.width,
            height: photo.height,
            blurhash: photo.blurhash,
            status: "done" as const,
            error: null,
            errorCode: null,
            canRetry: false,
          })),
          story: detail.story,
          title: detail.title,
          // #290: this title came from a saved listing — a human decision
          // (typed, or an earlier suggestion the giver already accepted by
          // publishing), not an empty slot for `SuggestionFetcher` to fill.
          // Spreading `GIVE_DRAFT_INITIAL` above brings `titleDirty: false`
          // along with the real `title` unless this overrides it, which is
          // exactly what let a fresh vision call silently overwrite it.
          titleDirty: true,
          category: detail.category,
          country: detail.country,
          listingId: detail.id,
        };
        dispatch({ type: "hydrate", draft: hydrated });
      })
      .catch(() => {
        // Leave the draft at its default; the give flow still works for a
        // fresh listing even if the prefill fetch fails.
      })
      .finally(() => {
        if (!cancelled) setSettled(true);
      });

    return () => {
      cancelled = true;
    };
  }, [editTargetOnce, draft.listingId, dispatch]);

  return { hydrating };
}

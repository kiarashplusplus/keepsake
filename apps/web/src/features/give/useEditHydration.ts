/**
 * When the URL carries `?edit=<listingId>` (the dashboard's Edit action —
 * see `app/mine/[id].tsx`), fetches that listing once and hydrates the give
 * draft from it so the give flow re-opens pre-filled.
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

export function useEditHydration(): void {
  const { edit } = useGlobalSearchParams<{ edit?: string }>();
  const { draft, dispatch } = useGiveDraft();

  React.useEffect(() => {
    if (typeof edit !== "string" || edit.length === 0 || edit === draft.listingId) return undefined;

    let cancelled = false;
    getMyListing(edit)
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
          category: detail.category,
          country: detail.country,
          listingId: detail.id,
        };
        dispatch({ type: "hydrate", draft: hydrated });
      })
      .catch(() => {
        // Leave the draft at its default; the give flow still works for a
        // fresh listing even if the prefill fetch fails.
      });

    return () => {
      cancelled = true;
    };
  }, [edit, draft.listingId, dispatch]);
}

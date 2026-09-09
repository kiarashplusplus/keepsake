// Fetches issue #39's browse-page shelves once (no pagination, no query
// params — shelves are computed globally over the current approved-listing
// set, not scoped to whatever location/search/category the visitor has
// dialed in, matching the API route's own docs/design/feed.md-adjacent
// comment in `apps/api/src/routes/feed.ts`). A failure here degrades to "no
// shelves" rather than surfacing an error banner: shelves are additive
// navigation (issue #40) and the plain feed grid below is the product even
// when this call never resolves.
import * as React from "react";
import type { AspectShelf } from "@keepsake/contracts/shelves";
import { getShelves } from "@/api/shelves";

export type UseShelvesResult = {
  shelves: AspectShelf[];
  loading: boolean;
};

export type UseShelvesOptions = {
  /** Skips the request entirely while `false`. `app/index.tsx` passes this
   * for the same reason it gates `useFeed`: on a first visit the feed is in
   * the document but hidden behind the explainer (`src/lib/firstVisit.ts`),
   * and a request for shelves nobody is looking at is a request the visitor
   * did not ask for. Measured on production's own bytes on 2026-09-09: the
   * page-1 fetch was gated, this one was not, and `/api/feed/shelves` went
   * out under the explainer on every first visit. */
  enabled?: boolean;
};

export function useShelves(options: UseShelvesOptions = {}): UseShelvesResult {
  const { enabled = true } = options;
  const [shelves, setShelves] = React.useState<AspectShelf[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    getShelves()
      .then((response) => {
        if (cancelled) return;
        setShelves(response.shelves);
      })
      .catch(() => {
        if (cancelled) return;
        setShelves([]);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { shelves, loading };
}

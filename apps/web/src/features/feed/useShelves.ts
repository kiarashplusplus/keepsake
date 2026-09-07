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

export function useShelves(): UseShelvesResult {
  const [shelves, setShelves] = React.useState<AspectShelf[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
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
  }, []);

  return { shelves, loading };
}

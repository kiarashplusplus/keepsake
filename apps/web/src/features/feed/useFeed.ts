// Data-fetching hook behind the feed page: owns items/cursor/loading state
// and re-fetches from page 1 whenever the query's *content* changes (keyed
// by a JSON string rather than object identity, since `app/index.tsx` builds
// a fresh `FeedQueryInput` object every render).
import * as React from "react";
import type { PublicListing } from "@keepsake/contracts/listing";
import { getFeed, type FeedQueryInput } from "@/api/feed";
import { ApiError } from "@/api/client";

const PAGE_SIZE = 24;

export type UseFeedResult = {
  items: PublicListing[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
};

export type UseFeedOptions = {
  /** Skips fetching entirely while `false` — used to wait for the
   * location preference to hydrate from `prefStore` before the first
   * request, so the feed doesn't fetch once with a default location and
   * again a tick later with the real one. */
  enabled?: boolean;
  /** Bump this to force a fresh page-1 fetch of the same query (the error
   * banner's "Try again"), without needing a synthetic field on the query
   * object itself. */
  reloadToken?: number;
};

export function useFeed(baseQuery: FeedQueryInput, options: UseFeedOptions = {}): UseFeedResult {
  const { enabled = true, reloadToken = 0 } = options;
  const [items, setItems] = React.useState<PublicListing[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // The key of the most recent fetch to *finish* (success or failure).
  // `loading` is derived from comparing this to the key that should be
  // loaded right now, rather than a separate `setLoading(true)` at the top
  // of the effect below — that would set state synchronously in the effect
  // body, which this repo's `react-hooks/set-state-in-effect` lint rule
  // flags (see SearchBar.tsx's identical comment) and which costs an extra
  // render a derived value doesn't.
  const [loadedRequestKey, setLoadedRequestKey] = React.useState<string | null>(null);

  const queryKey = JSON.stringify(baseQuery);
  const requestKey = `${queryKey}::${reloadToken}`;
  const loading = enabled && loadedRequestKey !== requestKey;

  React.useEffect(() => {
    if (!enabled) return undefined;

    let cancelled = false;

    getFeed({ ...baseQuery, limit: PAGE_SIZE })
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setCursor(page.next_cursor);
        setError(null);
        setLoadedRequestKey(requestKey);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Couldn't load the feed.");
        setLoadedRequestKey(requestKey);
      });

    return () => {
      cancelled = true;
    };
    // `baseQuery` is intentionally represented by `queryKey`/`requestKey`: a
    // fresh object every render must not re-trigger this effect unless its
    // content did.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, enabled, reloadToken]);

  const loadMore = React.useCallback(() => {
    if (!enabled || cursor === null || loadingMore) return;
    setLoadingMore(true);
    setError(null);

    getFeed({ ...baseQuery, cursor, limit: PAGE_SIZE })
      .then((page) => {
        setItems((current) => [...current, ...page.items]);
        setCursor(page.next_cursor);
      })
      .catch((err: unknown) => {
        setError(err instanceof ApiError ? err.message : "Couldn't load more.");
      })
      .finally(() => {
        setLoadingMore(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, loadingMore, queryKey, enabled]);

  return { items, loading, loadingMore, error, hasMore: cursor !== null, loadMore };
}

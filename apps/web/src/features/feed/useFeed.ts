// Data-fetching hook behind the feed page: owns items/cursor/loading state
// and re-fetches from page 1 whenever the query's *content* changes (keyed
// by a JSON string rather than object identity, since `app/index.tsx` builds
// a fresh `FeedQueryInput` object every render).
import * as React from "react";
import type { PublicListing } from "@keepsake/contracts/listing";
import { getFeed, type FeedQueryInput } from "@/api/feed";
import { ApiError } from "@/api/client";

const PAGE_SIZE = 24;

/**
 * Page 1 of the last few feed queries, so going back to the feed shows it
 * instead of re-fetching it.
 *
 * The feed is the app's front door and every visit to a keepsake leaves it
 * and comes back. Without this, "back" meant a mount with empty state, four
 * skeleton prints, a round trip to the Worker, a D1 query and a re-render —
 * for a list the visitor was looking at seconds earlier and that changes
 * when someone posts a keepsake, which is not a per-second event.
 *
 * Deliberately small and deliberately dumb: a module-level `Map` that lives
 * as long as the tab, at most `CACHE_LIMIT` queries, each usable for
 * `CACHE_TTL_MS`. Nothing here is persisted (a cache that survives a reload
 * would be a second, staler copy of the feed with no way to invalidate it)
 * and the entry is dropped the moment it is older than the TTL rather than
 * revalidated in the background — a fetch the visitor did not ask for, whose
 * result they may never see, is the thing this is trying to avoid.
 *
 * `reloadToken` (the error banner's "Try again", and the pull-to-refresh
 * this will grow) bypasses it: an explicit ask for fresh data must not be
 * answered from a cache.
 */
const CACHE_TTL_MS = 60_000;
const CACHE_LIMIT = 8;
type CachedPage = { items: PublicListing[]; cursor: string | null; at: number };
const page1Cache = new Map<string, CachedPage>();

function readCache(key: string): CachedPage | undefined {
  const hit = page1Cache.get(key);
  if (hit === undefined) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    page1Cache.delete(key);
    return undefined;
  }
  return hit;
}

function writeCache(key: string, page: Omit<CachedPage, "at">): void {
  page1Cache.set(key, { ...page, at: Date.now() });
  // Oldest insertion first, so this evicts the least recently *written*.
  while (page1Cache.size > CACHE_LIMIT) {
    const oldest = page1Cache.keys().next();
    if (oldest.done === true) break;
    page1Cache.delete(oldest.value);
  }
}

/** Exported for tests only: a module-level cache that outlives a render is
 * shared between test cases too, and a stale entry there is a test that
 * passes for the wrong reason. */
export function clearFeedCache(): void {
  page1Cache.clear();
}

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
  const initialKey = JSON.stringify(baseQuery);
  const seed = reloadToken === 0 ? readCache(initialKey) : undefined;
  const [items, setItems] = React.useState<PublicListing[]>(seed?.items ?? []);
  const [cursor, setCursor] = React.useState<string | null>(seed?.cursor ?? null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // The key of the most recent fetch to *finish* (success or failure).
  // `loading` is derived from comparing this to the key that should be
  // loaded right now, rather than a separate `setLoading(true)` at the top
  // of the effect below — that would set state synchronously in the effect
  // body, which this repo's `react-hooks/set-state-in-effect` lint rule
  // flags (see SearchBar.tsx's identical comment) and which costs an extra
  // render a derived value doesn't.
  const [loadedRequestKey, setLoadedRequestKey] = React.useState<string | null>(seed !== undefined ? `${initialKey}::0` : null);

  const queryKey = JSON.stringify(baseQuery);
  const requestKey = `${queryKey}::${reloadToken}`;
  // NOT `enabled && …`. `enabled` is false while `app/index.tsx` reads the
  // saved location out of storage, and a feed that reports "not loading, no
  // items" in that window renders the empty state — "Nothing here yet. Be
  // the first to give something." — to someone whose feed is about to
  // arrive. That is what the static export shipped as its first paint on
  // `/`, in the HTML, before any request had been made. Waiting for the
  // location IS loading, from the only point of view that matters.
  const loading = loadedRequestKey !== requestKey;

  React.useEffect(() => {
    if (!enabled) return undefined;
    if (loadedRequestKey === requestKey) return undefined;

    // A real abort, not just an ignored result: typing in the search box or
    // tapping through categories can leave several page-1 requests in
    // flight, and the ones nobody will read still cost the visitor's
    // connection, the Worker's CPU and a D1 query each. `getFeed` has taken
    // a signal all along; nothing passed one.
    const controller = new AbortController();

    getFeed({ ...baseQuery, limit: PAGE_SIZE }, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setItems(page.items);
        setCursor(page.next_cursor);
        setError(null);
        setLoadedRequestKey(requestKey);
        writeCache(queryKey, { items: page.items, cursor: page.next_cursor });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof ApiError ? err.message : "Couldn't load the feed.");
        setLoadedRequestKey(requestKey);
      });

    return () => {
      controller.abort();
    };
    // `baseQuery` is intentionally represented by `queryKey`/`requestKey`: a
    // fresh object every render must not re-trigger this effect unless its
    // content did. `loadedRequestKey` is read but not a dep: it changes when
    // this effect's own fetch lands, and re-running on that would refetch
    // the page that just arrived.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, enabled, reloadToken]);

  // The request key as of the latest render, readable from inside a promise
  // that was created several renders ago. The page-1 effect gets the same
  // protection from its `cancelled` flag, which its own cleanup flips; a
  // callback has no cleanup to hang that on.
  const currentRequestKeyRef = React.useRef(requestKey);
  React.useEffect(() => {
    currentRequestKeyRef.current = requestKey;
  }, [requestKey]);

  const loadMore = React.useCallback(() => {
    // `loading` is in the guard because between a query changing and its page
    // 1 landing, `cursor` still holds the *previous* query's cursor — so a
    // sentinel that scrolls into view in that window would ask the new query
    // to continue from the old query's position.
    if (!enabled || cursor === null || loadingMore || loading) return;
    // Which query this page is for. `LoadMoreSentinel` fires this from an
    // IntersectionObserver the moment the sentinel appears, so it is in
    // flight far more often than a "More" button would be, and the visitor
    // does not have to try to hit the race: tap a category chip while page 2
    // is out and, without this, its 24 unfiltered listings appended
    // underneath the filtered ones and `cursor` became the *unfiltered*
    // query's cursor, so every later "More" kept paginating the query they
    // abandoned (#187).
    const firedFor = requestKey;
    setLoadingMore(true);
    setError(null);

    getFeed({ ...baseQuery, cursor, limit: PAGE_SIZE })
      .then((page) => {
        if (currentRequestKeyRef.current !== firedFor) return;
        setItems((current) => {
          const next = [...current, ...page.items];
          // The cache holds what the visitor was actually looking at, not
          // just page 1 — otherwise "back" after scrolling four pages deep
          // drops them at the top of a 24-item feed.
          writeCache(queryKey, { items: next, cursor: page.next_cursor });
          return next;
        });
        setCursor(page.next_cursor);
      })
      .catch((err: unknown) => {
        if (currentRequestKeyRef.current !== firedFor) return;
        setError(err instanceof ApiError ? err.message : "Couldn't load more.");
      })
      .finally(() => {
        // Unconditional, unlike the two above: `loadingMore` is the flag that
        // stops a second `loadMore` starting, so leaving it true for an
        // abandoned request would wedge pagination for the *new* query
        // forever. Nothing else can have set it in the meantime — the guard
        // at the top of this callback is what guarantees only one page-N
        // request is ever in flight.
        setLoadingMore(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, loadingMore, loading, requestKey, queryKey, enabled]);

  return { items, loading, loadingMore, error, hasMore: cursor !== null, loadMore };
}

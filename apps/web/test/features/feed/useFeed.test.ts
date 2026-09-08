/**
 * The first `useFeed` test in the repo (issue #187 — `test/features/feed/`
 * held only `LocationBar.test.tsx` and `feedUrlParams.test.ts`, which is why
 * the asymmetry between the hook's two fetch paths went unnoticed for so
 * long).
 *
 * The page-1 effect guards its own race with a `cancelled` flag; `loadMore`
 * had no equivalent, so the previous query's page 2 appended to the new
 * query's results and, worse, overwrote `cursor` with the abandoned query's
 * cursor — after which every later "More" kept paginating the query the
 * visitor had left. `LoadMoreSentinel` fires `loadMore` from an
 * IntersectionObserver as soon as the sentinel scrolls into view, so this is
 * not a race a visitor has to try to hit.
 */
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { FeedPage } from "@keepsake/contracts/feed";
import type { PublicListing } from "@keepsake/contracts/listing";
import { getFeed, type FeedQueryInput } from "@/api/feed";
import { clearFeedCache, useFeed } from "@/features/feed/useFeed";

jest.mock("@/api/feed", () => ({ getFeed: jest.fn() }));

type Page = FeedPage<PublicListing>;

/** Only `id` is read by anything under test — the hook does no validation of
 * its own (`getFeed` is where the zod parse lives, and it is mocked here). */
function page(ids: string[], nextCursor: string | null): Page {
  return { items: ids.map((id) => ({ id })), next_cursor: nextCursor } as unknown as Page;
}

function deferred(): { promise: Promise<Page>; resolve: (value: Page) => void } {
  let resolve!: (value: Page) => void;
  const promise = new Promise<Page>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function ids(items: readonly PublicListing[]): string[] {
  return items.map((item) => item.id);
}

describe("useFeed", () => {
  beforeEach(() => {
    jest.mocked(getFeed).mockReset();
    // The page-1 cache is module state, so it outlives a test. A hit left
    // over from the case above would make the next one pass without ever
    // calling `getFeed` — the exact "test that cannot fail" this repo keeps
    // finding.
    clearFeedCache();
  });

  it("appends page 2 to page 1 and advances the cursor", async () => {
    jest.mocked(getFeed).mockImplementation((query: FeedQueryInput) => {
      if (query.cursor === undefined) return Promise.resolve(page(["a-1"], "cursor-2"));
      if (query.cursor === "cursor-2") return Promise.resolve(page(["a-2"], null));
      throw new Error(`unexpected query: ${JSON.stringify(query)}`);
    });

    const { result } = renderHook(() => useFeed({ q: "a" }));

    await waitFor(() => expect(ids(result.current.items)).toEqual(["a-1"]));
    expect(result.current.hasMore).toBe(true);

    act(() => {
      result.current.loadMore();
    });

    await waitFor(() => expect(ids(result.current.items)).toEqual(["a-1", "a-2"]));
    // `next_cursor: null` — the end of the feed.
    expect(result.current.hasMore).toBe(false);
  });

  it("GUARD: a page 2 that lands after the query changed is neither appended nor allowed to set the cursor", async () => {
    const stalePage2 = deferred();

    jest.mocked(getFeed).mockImplementation((query: FeedQueryInput) => {
      if (query.q === "old" && query.cursor === undefined) return Promise.resolve(page(["old-1"], "cursor-old-2"));
      if (query.q === "old" && query.cursor === "cursor-old-2") return stalePage2.promise;
      if (query.q === "new" && query.cursor === undefined) return Promise.resolve(page(["new-1"], "cursor-new-2"));
      if (query.q === "new" && query.cursor === "cursor-new-2") return Promise.resolve(page(["new-2"], null));
      throw new Error(`unexpected query: ${JSON.stringify(query)}`);
    });

    const { result, rerender } = renderHook(({ q }: { q: string }) => useFeed({ q }), {
      initialProps: { q: "old" },
    });

    await waitFor(() => expect(ids(result.current.items)).toEqual(["old-1"]));

    // The sentinel scrolls into view and page 2 of the old query goes out.
    act(() => {
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.loadingMore).toBe(true));

    // ...and before it comes back, the visitor taps a different chip.
    rerender({ q: "new" });
    await waitFor(() => expect(ids(result.current.items)).toEqual(["new-1"]));

    // Now the abandoned query's page 2 arrives.
    await act(async () => {
      stalePage2.resolve(page(["old-2"], "cursor-old-3"));
      await stalePage2.promise;
    });

    // It appended `old-2` under the filtered results before this fix.
    expect(ids(result.current.items)).toEqual(["new-1"]);
    expect(result.current.hasMore).toBe(true);
    // And `loadingMore` still has to come back down, or pagination is wedged
    // for the query the visitor is actually looking at.
    await waitFor(() => expect(result.current.loadingMore).toBe(false));

    // The real damage was the cursor: prove the next "More" continues the NEW
    // query, not the one that was abandoned. `cursor-old-3` would throw in
    // the mock above.
    act(() => {
      result.current.loadMore();
    });
    await waitFor(() => expect(ids(result.current.items)).toEqual(["new-1", "new-2"]));
    expect(jest.mocked(getFeed)).toHaveBeenCalledWith(expect.objectContaining({ q: "new", cursor: "cursor-new-2" }));
    expect(jest.mocked(getFeed)).not.toHaveBeenCalledWith(expect.objectContaining({ cursor: "cursor-old-3" }));
  });

  it("GUARD: does not paginate from the previous query's cursor while the new query's page 1 is still in flight", async () => {
    const newPage1 = deferred();

    jest.mocked(getFeed).mockImplementation((query: FeedQueryInput) => {
      if (query.q === "old" && query.cursor === undefined) return Promise.resolve(page(["old-1"], "cursor-old-2"));
      if (query.q === "new" && query.cursor === undefined) return newPage1.promise;
      throw new Error(`unexpected query: ${JSON.stringify(query)}`);
    });

    const { result, rerender } = renderHook(({ q }: { q: string }) => useFeed({ q }), {
      initialProps: { q: "old" },
    });
    await waitFor(() => expect(ids(result.current.items)).toEqual(["old-1"]));

    rerender({ q: "new" });
    const callsBefore = jest.mocked(getFeed).mock.calls.length;

    // The sentinel is still on screen while the new query's page 1 is out.
    // `cursor` at this instant is the OLD query's, so firing here would ask
    // the new query to continue from the old query's position — the mock
    // above throws on exactly that combination.
    act(() => {
      result.current.loadMore();
    });
    expect(jest.mocked(getFeed).mock.calls.length).toBe(callsBefore);

    await act(async () => {
      newPage1.resolve(page(["new-1"], null));
      await newPage1.promise;
    });
    expect(ids(result.current.items)).toEqual(["new-1"]);
  });

  it("reports loading while the caller is still deciding what to ask for", async () => {
    // `app/index.tsx` holds `enabled: false` until the saved location comes
    // back from storage. This used to report `loading: false` with no items,
    // which the feed screen renders as "Nothing here yet. Be the first to
    // give something." — to a visitor whose feed is one tick away. It is
    // also what the static export baked into the HTML of `/` as its first
    // paint.
    jest.mocked(getFeed).mockResolvedValue(page(["a-1"], null));

    const { result, rerender } = renderHook(({ enabled }: { enabled: boolean }) => useFeed({ q: "a" }, { enabled }), {
      initialProps: { enabled: false },
    });

    expect(result.current.loading).toBe(true);
    expect(result.current.items).toEqual([]);
    expect(jest.mocked(getFeed)).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(ids(result.current.items)).toEqual(["a-1"]);
  });

  it("serves the same query from cache on a remount, and does not refetch", async () => {
    // Feed -> keepsake -> back is the app's most common movement. Without
    // this it was a fresh mount, four skeletons, and a round trip for a list
    // the visitor was looking at seconds ago.
    jest.mocked(getFeed).mockResolvedValue(page(["a-1"], "cursor-2"));

    const first = renderHook(() => useFeed({ q: "cached" }));
    await waitFor(() => expect(ids(first.result.current.items)).toEqual(["a-1"]));
    first.unmount();

    const second = renderHook(() => useFeed({ q: "cached" }));
    // Synchronously, on the first render — no skeleton frame at all.
    expect(ids(second.result.current.items)).toEqual(["a-1"]);
    expect(second.result.current.loading).toBe(false);
    expect(second.result.current.hasMore).toBe(true);
    expect(jest.mocked(getFeed)).toHaveBeenCalledTimes(1);
  });

  it("does not serve a different query, or an explicit reload, from that cache", async () => {
    jest.mocked(getFeed).mockImplementation((query: FeedQueryInput) => Promise.resolve(page([`${query.q ?? "all"}-1`], null)));

    const first = renderHook(() => useFeed({ q: "one" }));
    await waitFor(() => expect(ids(first.result.current.items)).toEqual(["one-1"]));
    first.unmount();

    // A different query is a different key.
    const other = renderHook(() => useFeed({ q: "two" }));
    expect(other.result.current.items).toEqual([]);
    await waitFor(() => expect(ids(other.result.current.items)).toEqual(["two-1"]));
    other.unmount();

    // And "Try again" must reach the server even for a query in the cache:
    // the visitor is asking precisely because what they were shown was
    // wrong.
    const reloaded = renderHook(() => useFeed({ q: "one" }, { reloadToken: 1 }));
    expect(reloaded.result.current.items).toEqual([]);
    await waitFor(() => expect(ids(reloaded.result.current.items)).toEqual(["one-1"]));
    expect(jest.mocked(getFeed)).toHaveBeenCalledTimes(3);
  });

  it("aborts a page-1 request the visitor has moved on from", async () => {
    // Typing in the search box or tapping through categories leaves page-1
    // requests behind. Ignoring their results was never the same as not
    // paying for them: each one still costs the visitor's connection, a
    // Worker invocation and a D1 query.
    const abandoned = deferred();
    const signals: (AbortSignal | undefined)[] = [];
    jest.mocked(getFeed).mockImplementation((query: FeedQueryInput, signal?: AbortSignal) => {
      signals.push(signal);
      if (query.q === "old") return abandoned.promise;
      return Promise.resolve(page(["new-1"], null));
    });

    const { result, rerender } = renderHook(({ q }: { q: string }) => useFeed({ q }), { initialProps: { q: "old" } });
    await waitFor(() => expect(signals.length).toBe(1));
    expect(signals[0]?.aborted).toBe(false);

    rerender({ q: "new" });

    expect(signals[0]?.aborted).toBe(true);
    await waitFor(() => expect(ids(result.current.items)).toEqual(["new-1"]));
  });
});
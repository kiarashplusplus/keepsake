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
import { useFeed } from "@/features/feed/useFeed";

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
});

import {
  indexOfItem,
  initialQueueState,
  queueReducer,
  type QueueState,
} from "@/features/admin/queueReducer";
import type { AdminQueueItem } from "@keepsake/contracts/admin";

/** Just enough of `AdminQueueItem` for the reducer, which never looks past
 * `id` — same minimal-fixture approach as the rest of this file's siblings
 * (`test/lib/masonry.test.ts`'s `square()`), not a full API fixture. */
function item(id: string): AdminQueueItem {
  return {
    id,
    title: `Listing ${id}`,
    story: "story",
    status: "needs_review",
    category: "home_kitchen",
    place_name: "Somerville",
    admin1: "MA",
    country: "US",
    photos: [],
    aspects: [],
    published_at: 0,
    postal_code: "02144",
    moderation_reason: null,
    request_count: 0,
    chosen_request_id: null,
    version: 1,
    created_at: 0,
    updated_at: 0,
    held: false,
    category_chosen_at: null,
    report_count: 0,
    owner: { id: "owner1", email_masked: null, email_verified: false, banned: false },
    events: [],
    reports: [],
  };
}

function loadedState(ids: string[]): QueueState {
  return queueReducer(initialQueueState(), {
    type: "load_success",
    status: "needs_review",
    page: { items: ids.map(item), next_cursor: null },
    append: false,
  });
}

describe("queueReducer", () => {
  it("remove drops a single item and leaves the rest, in order", () => {
    const state = loadedState(["a", "b", "c"]);
    const next = queueReducer(state, { type: "remove", status: "needs_review", id: "b" });
    expect(next.needs_review.items.map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("reinsert puts an item back at the given index — the undo half of remove", () => {
    const state = loadedState(["a", "b", "c"]);
    const removedIndex = indexOfItem(state, "needs_review", "b");
    const afterRemove = queueReducer(state, { type: "remove", status: "needs_review", id: "b" });
    const afterUndo = queueReducer(afterRemove, {
      type: "reinsert",
      status: "needs_review",
      item: item("b"),
      index: removedIndex,
    });
    expect(afterUndo.needs_review.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("remove_many drops every id in the set in one update, regardless of order", () => {
    const state = loadedState(["a", "b", "c", "d", "e"]);
    const next = queueReducer(state, {
      type: "remove_many",
      status: "needs_review",
      ids: ["e", "b", "d"],
    });
    expect(next.needs_review.items.map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("remove_many is a no-op for ids not present, and leaves other tabs untouched", () => {
    const state = loadedState(["a", "b"]);
    const next = queueReducer(state, {
      type: "remove_many",
      status: "needs_review",
      ids: ["not-there", "b"],
    });
    expect(next.needs_review.items.map((i) => i.id)).toEqual(["a"]);
    expect(next.hidden.items).toEqual([]);
  });

  it("remove_many against an empty selection changes nothing", () => {
    const state = loadedState(["a", "b"]);
    const next = queueReducer(state, { type: "remove_many", status: "needs_review", ids: [] });
    expect(next.needs_review.items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  // #286: the two undos whose reversal doesn't land at one well-known index
  // (banning/unbanning an owner can touch listings this client never
  // fetched) mark a tab stale instead of guessing — this is that half of
  // the fix, independent of whether the tab happens to be active right now.
  it("invalidate clears loadedOnce on the named tabs without touching their items", () => {
    const state = loadedState(["a", "b"]);
    const next = queueReducer(state, { type: "invalidate", statuses: ["needs_review"] });
    expect(next.needs_review.loadedOnce).toBe(false);
    // Items stay put — the tab-load effect replaces them once the refetch
    // resolves, so nothing flashes to an empty state in the meantime.
    expect(next.needs_review.items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("invalidate leaves tabs not named in statuses untouched", () => {
    const state = loadedState(["a"]);
    const next = queueReducer(state, { type: "invalidate", statuses: ["hidden"] });
    expect(next.needs_review.loadedOnce).toBe(true);
    expect(next.hidden.loadedOnce).toBe(false);
  });

  // #291: a re-authenticated admin (a 401 mid-session, or Forget) must not
  // keep showing a previous session's queue — every tab's loadedOnce has to
  // come back false so the load effect refetches instead of trusting stale
  // state.
  it("reset returns every tab to its initial, never-fetched state", () => {
    const state = loadedState(["a", "b", "c"]);
    const next = queueReducer(state, { type: "reset" });
    expect(next).toEqual(initialQueueState());
    expect(next.needs_review.loadedOnce).toBe(false);
    expect(next.needs_review.items).toEqual([]);
  });
});

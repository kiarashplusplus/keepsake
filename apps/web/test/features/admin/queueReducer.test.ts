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
});

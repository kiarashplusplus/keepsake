/**
 * Pure state machine for the four queue tabs (`ADMIN_QUEUE_STATUSES`):
 * loading, pagination, and the optimistic remove/reinsert pair that backs
 * `app/admin.tsx`'s "act now, undo on the toast" flow. Kept dependency-free
 * (no API calls, no React) so it's testable the same way
 * `src/lib/masonry.ts`'s column assignment is — same input always produces
 * the same output.
 */
import { ADMIN_QUEUE_STATUSES, type AdminQueueItem, type AdminQueueStatus } from "@keepsake/contracts/admin";
import type { FeedPage } from "@keepsake/contracts/feed";

export type QueueTabState = {
  items: AdminQueueItem[];
  cursor: string | null;
  loading: boolean;
  error: string | null;
  /** Distinguishes "never fetched" from "fetched, zero rows" so the empty
   * state doesn't flash before the first request resolves. */
  loadedOnce: boolean;
};

export type QueueState = Record<AdminQueueStatus, QueueTabState>;

export function initialTabState(): QueueTabState {
  return { items: [], cursor: null, loading: false, error: null, loadedOnce: false };
}

export function initialQueueState(): QueueState {
  return Object.fromEntries(ADMIN_QUEUE_STATUSES.map((status) => [status, initialTabState()])) as QueueState;
}

export type QueueAction =
  | { type: "load_start"; status: AdminQueueStatus }
  | { type: "load_success"; status: AdminQueueStatus; page: FeedPage<AdminQueueItem>; append: boolean }
  | { type: "load_error"; status: AdminQueueStatus; error: string }
  /** Optimistic removal, e.g. right after Approve/Hide/Reject is sent —
   * called before the request resolves so the queue feels instant. */
  | { type: "remove"; status: AdminQueueStatus; id: string }
  /** Puts an item back at a specific index — the undo half of `remove`. */
  | { type: "reinsert"; status: AdminQueueStatus; item: AdminQueueItem; index: number };

function updateTab(state: QueueState, status: AdminQueueStatus, patch: Partial<QueueTabState>): QueueState {
  return { ...state, [status]: { ...state[status], ...patch } };
}

export function queueReducer(state: QueueState, action: QueueAction): QueueState {
  switch (action.type) {
    case "load_start":
      return updateTab(state, action.status, { loading: true, error: null });

    case "load_success": {
      const previousItems = action.append ? state[action.status].items : [];
      return updateTab(state, action.status, {
        items: [...previousItems, ...action.page.items],
        cursor: action.page.next_cursor,
        loading: false,
        error: null,
        loadedOnce: true,
      });
    }

    case "load_error":
      return updateTab(state, action.status, { loading: false, error: action.error, loadedOnce: true });

    case "remove":
      return updateTab(state, action.status, {
        items: state[action.status].items.filter((item) => item.id !== action.id),
      });

    case "reinsert": {
      const items = state[action.status].items.slice();
      const index = Math.min(Math.max(action.index, 0), items.length);
      items.splice(index, 0, action.item);
      return updateTab(state, action.status, { items });
    }

    default:
      return state;
  }
}

/** Finds an item's current index within a tab, or `-1` — used right before
 * dispatching `remove` so the caller has what it needs to `reinsert` on
 * undo without the reducer itself needing to hand indices back out. */
export function indexOfItem(state: QueueState, status: AdminQueueStatus, id: string): number {
  return state[status].items.findIndex((item) => item.id === id);
}

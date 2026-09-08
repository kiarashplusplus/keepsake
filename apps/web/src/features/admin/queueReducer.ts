/**
 * Pure state machine for the four queue tabs (`ADMIN_QUEUE_STATUSES`):
 * loading, pagination, and the optimistic remove/reinsert pair that backs
 * `app/admin.tsx`'s "act now, undo on the toast" flow. Kept dependency-free
 * (no API calls, no React) so it's testable the same way
 * `src/lib/masonry.ts`'s column assignment is — same input always produces
 * the same output.
 */
import {
  ADMIN_QUEUE_STATUSES,
  type AdminQueueItem,
  type AdminQueueStatus,
} from "@keepsake/contracts/admin";
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
  return Object.fromEntries(
    ADMIN_QUEUE_STATUSES.map((status) => [status, initialTabState()]),
  ) as QueueState;
}

export type QueueAction =
  | { type: "load_start"; status: AdminQueueStatus }
  | {
      type: "load_success";
      status: AdminQueueStatus;
      page: FeedPage<AdminQueueItem>;
      append: boolean;
    }
  | { type: "load_error"; status: AdminQueueStatus; error: string }
  /** Optimistic removal, e.g. right after Approve/Hide/Reject is sent —
   * called before the request resolves so the queue feels instant. */
  | { type: "remove"; status: AdminQueueStatus; id: string }
  /** The bulk-action equivalent of `remove`: one state update instead of one
   * per selected item, and — unlike single-item actions — a bulk action
   * already waited for every call to settle before this fires, so there is
   * no optimistic-then-reinsert dance to support (see `app/admin.tsx`'s
   * bulk handlers). */
  | { type: "remove_many"; status: AdminQueueStatus; ids: string[] }
  /** Puts an item back at a specific index — the undo half of `remove`. */
  | { type: "reinsert"; status: AdminQueueStatus; item: AdminQueueItem; index: number }
  /** Marks one or more tabs as needing a real refetch — `loadedOnce` back to
   * `false` without touching `items`/`cursor`, so whatever's on screen stays
   * put (no flash to empty) until the tab-load effect replaces it. For an
   * undo whose reversal doesn't land the item at a single well-known index
   * (owner-wide actions can touch listings this client never fetched), this
   * is the honest alternative to a guessed `reinsert`: come back stale, then
   * self-correct, instead of confidently wrong. */
  | { type: "invalidate"; statuses: AdminQueueStatus[] }
  /** Back to every tab's `initialTabState()` — a fresh session (re-auth
   * after a 401, or Forget) has no business trusting what a *previous* one
   * loaded; see `app/admin.tsx`'s `handleSessionExpired`/`handleForget`. */
  | { type: "reset" };

function updateTab(
  state: QueueState,
  status: AdminQueueStatus,
  patch: Partial<QueueTabState>,
): QueueState {
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
      return updateTab(state, action.status, {
        loading: false,
        error: action.error,
        loadedOnce: true,
      });

    case "remove":
      return updateTab(state, action.status, {
        items: state[action.status].items.filter((item) => item.id !== action.id),
      });

    case "remove_many": {
      const ids = new Set(action.ids);
      return updateTab(state, action.status, {
        items: state[action.status].items.filter((item) => !ids.has(item.id)),
      });
    }

    case "reinsert": {
      const items = state[action.status].items.slice();
      const index = Math.min(Math.max(action.index, 0), items.length);
      items.splice(index, 0, action.item);
      return updateTab(state, action.status, { items });
    }

    case "invalidate": {
      let next = state;
      for (const status of action.statuses) {
        next = updateTab(next, status, { loadedOnce: false });
      }
      return next;
    }

    case "reset":
      return initialQueueState();

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

import * as React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import type { ReactTestInstance } from "react-test-renderer";
import type { AdminHealth, AdminQueueItem, AdminStats } from "@keepsake/contracts/admin";
import { ToastProvider } from "@/ui/Toast";
import { ADMIN_TOKEN_STORAGE_KEY } from "@/lib/adminToken";
import {
  approveListing,
  getAdminHealth,
  getAdminQueue,
  getAdminStats,
  hideListing,
  rejectListing,
} from "@/api/admin";
import AdminPage from "../../app/admin";

/**
 * The queue's keyboard path (`app/admin.tsx`'s `onKeyDown`) is real
 * `document.addEventListener`, not React's synthetic event system, since it
 * has to work regardless of which element on the page currently has DOM
 * focus. This test drives it the same way a real keypress would: a genuine
 * `KeyboardEvent` dispatched on `document`.
 *
 * Content and interaction assertions follow this test suite's existing
 * convention (`test/app/index.test.tsx`, `test/app/give/review.test.tsx`),
 * not the more familiar `getByText`/`getByLabelText`: this project's
 * `jest-expo/web` setup renders through react-native-web to plain DOM nodes
 * (`div`, `button`), and `@testing-library/react-native`'s text/label
 * queries only recognize react-native's own host component type names
 * ('Text', 'RCTText' — see `isHostText` in its `host-component-names`
 * helper), so they find nothing here. `toJSON()` + `toContain()` for
 * content, `UNSAFE_getAllByProps({ accessibilityLabel })` + `fireEvent.press`
 * for interaction, is what actually works against this render pipeline.
 */

// See test/features/report/ReportSheet.test.tsx's identical mock: RN's
// `Modal` (behind `src/ui/Sheet.tsx`) portals via `ReactDOM.createPortal`,
// which react-test-renderer's tree can't host ("An invalid container has
// been provided... This is not supported"). Swapping it for a plain
// conditional render keeps the reason sheet's own content (and its Approve/
// Hide/Reject confirm button) reachable the same way every other sheet-based
// test in this suite already does.
jest.mock("@/ui/Sheet", () => {
  const ReactActual = jest.requireActual("react");
  return {
    // Unlike `ReportSheet.test.tsx`'s version of this mock, `title` is kept
    // (as a plain string sibling) rather than dropped: this suite's bulk
    // tests assert on the exact count baked into the title
    // (`ReasonSheet`'s `title="Hide 2 listings?"` etc.), which is issue
    // #11's whole point — a destructive bulk action stating how many rows
    // it affects.
    Sheet: ({
      visible,
      title,
      children,
    }: {
      visible: boolean;
      title?: string;
      children: React.ReactNode;
    }) =>
      visible
        ? ReactActual.createElement(ReactActual.Fragment, null, title ?? null, children)
        : null,
  };
});

jest.mock("@/api/admin", () => ({
  getAdminHealth: jest.fn(),
  getAdminQueue: jest.fn(),
  getAdminStats: jest.fn(),
  approveListing: jest.fn(),
  hideListing: jest.fn(),
  restoreListing: jest.fn(),
  rejectListing: jest.fn(),
  banOwner: jest.fn(),
  unbanOwner: jest.fn(),
}));

const STATS: AdminStats = {
  listings_by_status: {
    pending: 0,
    approved: 0,
    rejected: 0,
    needs_review: 2,
    hidden: 0,
    given: 0,
    withdrawn: 0,
  },
  requests_today: 0,
  email_failures_today: 0,
  ai_budget_used_today: { mod_text: 0, mod_image: 0 },
};

const HEALTH: AdminHealth = {
  ok: true,
  postal_codes_count: 1,
  cron_last_run: { moderationRetry: 0, orphanSweep: 0 },
};

function item(id: string, title: string): AdminQueueItem {
  return {
    id,
    title,
    story: "story",
    status: "needs_review",
    category: "home_kitchen",
    place_name: "Somerville",
    admin1: "MA",
    country: "US",
    photos: [],
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
    owner: { id: `owner-${id}`, email_masked: null, email_verified: false, banned: false },
    events: [],
    reports: [],
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

/**
 * The keydown listener is a `useEffect` that resubscribes with a fresh
 * closure whenever `selectedIds`/`focusedIndex`/etc. change, and that
 * resubscription runs as a passive effect on the next tick, not synchronously
 * inside the `act()` that dispatched the event. Flushing after every single
 * keypress (not just once at the end of a sequence) is what keeps a second,
 * immediately-following press from landing on the listener's stale,
 * pre-update closure.
 */
async function pressKey(key: string): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    await flush();
  });
}

/** The sheet's own confirm button often shares a label with a per-card
 * button (both "Hide", for instance) — it's declared last in
 * `app/admin.tsx`'s JSX, after the queue list, so it's the last match in
 * tree order. Throws with the label in the message if nothing matched,
 * rather than a bare "undefined" from `.at(-1)`. */
function lastWithLabel(matches: ReactTestInstance[], label: string): ReactTestInstance {
  const match = matches.at(-1);
  if (match === undefined) throw new Error(`No element found with accessibilityLabel "${label}"`);
  return match;
}

describe("/admin queue: keyboard and bulk actions", () => {
  beforeEach(() => {
    window.sessionStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, "e2e-admin");
    jest.mocked(getAdminStats).mockResolvedValue(STATS);
    jest.mocked(getAdminHealth).mockResolvedValue(HEALTH);
    jest.mocked(getAdminQueue).mockImplementation(async (_token, options) => {
      if (options.status === "needs_review") {
        return { items: [item("a", "Rusty key"), item("b", "Broken locket")], next_cursor: null };
      }
      return { items: [], next_cursor: null };
    });
    jest.mocked(approveListing).mockResolvedValue({} as never);
    jest.mocked(hideListing).mockResolvedValue({} as never);
    jest.mocked(rejectListing).mockResolvedValue({} as never);
  });

  afterEach(() => {
    window.sessionStorage.clear();
    jest.clearAllMocks();
  });

  it("skips the token gate when a token is already on file, and lists the queue", async () => {
    const { toJSON } = render(
      <ToastProvider>
        <AdminPage />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });

    const tree = JSON.stringify(toJSON());
    expect(tree).not.toContain("Enter the admin token");
    expect(tree).toContain("Rusty key");
    expect(tree).toContain("Broken locket");
  });

  it("'a' approves whichever row the roving focus is on, with zero clicks", async () => {
    render(
      <ToastProvider>
        <AdminPage />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });

    // Focus starts on the first row (`focusedIndex` defaults to 0).
    await pressKey("a");

    expect(jest.mocked(approveListing)).toHaveBeenCalledTimes(1);
    expect(jest.mocked(approveListing)).toHaveBeenCalledWith("e2e-admin", "a");
  });

  it("ArrowDown moves the roving focus, so 'a' after it acts on the second row", async () => {
    render(
      <ToastProvider>
        <AdminPage />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });

    await pressKey("ArrowDown");
    await pressKey("a");

    expect(jest.mocked(approveListing)).toHaveBeenCalledTimes(1);
    expect(jest.mocked(approveListing)).toHaveBeenCalledWith("e2e-admin", "b");
  });

  it("x selects the focused row, and the bulk bar states the exact count before hiding fires", async () => {
    const { toJSON, UNSAFE_getAllByProps } = render(
      <ToastProvider>
        <AdminPage />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });

    // Select both rows: the focused one, then the next after moving down.
    await pressKey("x");
    await pressKey("ArrowDown");
    await pressKey("x");

    expect(JSON.stringify(toJSON())).toContain("2 selected");

    await act(async () => {
      fireEvent.press(
        lastWithLabel(UNSAFE_getAllByProps({ accessibilityLabel: "Hide 2" }), "Hide 2"),
      );
      await flush();
    });

    expect(JSON.stringify(toJSON())).toContain("Hide 2 listings?");

    await act(async () => {
      fireEvent.press(lastWithLabel(UNSAFE_getAllByProps({ accessibilityLabel: "Hide" }), "Hide"));
      await flush();
    });

    expect(jest.mocked(hideListing)).toHaveBeenCalledTimes(2);
    expect(jest.mocked(hideListing)).toHaveBeenCalledWith("e2e-admin", "a", {});
    expect(jest.mocked(hideListing)).toHaveBeenCalledWith("e2e-admin", "b", {});
  });

  it("a destructive bulk action still needs the reason its single-item sheet needs", async () => {
    const { toJSON, UNSAFE_getAllByProps } = render(
      <ToastProvider>
        <AdminPage />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });

    await pressKey("x");

    await act(async () => {
      fireEvent.press(
        lastWithLabel(UNSAFE_getAllByProps({ accessibilityLabel: "Reject 1" }), "Reject 1"),
      );
      await flush();
    });

    expect(JSON.stringify(toJSON())).toContain("Reject 1 listings");

    // No reason picked yet: nothing has been sent.
    expect(jest.mocked(rejectListing)).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(
        lastWithLabel(
          UNSAFE_getAllByProps({ accessibilityLabel: "Photos need to show the keepsake itself." }),
          "Photos need to show the keepsake itself.",
        ),
      );
      await flush();
    });
    await act(async () => {
      fireEvent.press(
        lastWithLabel(UNSAFE_getAllByProps({ accessibilityLabel: "Reject" }), "Reject"),
      );
      await flush();
    });

    expect(jest.mocked(rejectListing)).toHaveBeenCalledWith("e2e-admin", "a", {
      reason: "not_an_object",
    });
  });
});

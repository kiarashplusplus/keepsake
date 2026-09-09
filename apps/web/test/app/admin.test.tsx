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
  restoreListing,
} from "@/api/admin";
import AdminPage from "../../app/admin";
import { ThemeProvider } from "@/ui/theme";
import { contrastRatio } from "@keepsake/tokens/contrast";
import { colorsLight } from "@keepsake/tokens/colors";
import { AA, hexOf, paperUnder, styleOf, walk, type Node } from "../support/paper";

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
  email_events_7d: { window_days: 7, total: 0, ok: 0, failed: 0, by_error: [], failures_by_domain: [] },
};

const HEALTH: AdminHealth = {
  ok: true,
  postal_codes_count: 1,
  cron_last_run: { moderationRetry: 0, orphanSweep: 0 },
  report_pressure: { threshold: 3, autohidden_awaiting_review: [], near_threshold: [] },
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

/** A verified session with two rows waiting: the token on file, stats and
 * health answering, and `needs_review` holding two listings. */
function mockAdminApi(): void {
  window.sessionStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, "e2e-admin");
  jest.mocked(getAdminStats).mockResolvedValue(STATS);
  jest.mocked(getAdminHealth).mockResolvedValue(HEALTH);
  jest.mocked(getAdminQueue).mockImplementation(async (_token, options) => {
    if (options.status === "needs_review") {
      return { items: [item("a", "Rusty key"), item("b", "Broken locket")], next_cursor: null };
    }
    return { items: [], next_cursor: null };
  });
}

describe("/admin queue: keyboard and bulk actions", () => {
  beforeEach(() => {
    mockAdminApi();
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

    // #354: the chip says the short moderator-facing label, and the sentence
    // the giver receives is not on the sheet until a reason is picked.
    expect(JSON.stringify(toJSON())).not.toContain("Photos need to show the keepsake itself.");

    await act(async () => {
      fireEvent.press(
        lastWithLabel(UNSAFE_getAllByProps({ accessibilityLabel: "Not an object" }), "Not an object"),
      );
      await flush();
    });

    expect(JSON.stringify(toJSON())).toContain("Photos need to show the keepsake itself.");

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

  // #363: an image pass's flags used to print as the whole JSON scorecard —
  // four wrapped lines of zeros per event at 390px. The line now names only
  // what was raised, and the JSON is behind the card's "Show raw".
  it("summarises an event's flags to what was raised, with the raw JSON behind a disclosure", async () => {
    const flagged = item("f", "Flagged clock");
    flagged.events = [
      {
        kind: "image",
        model: "@cf/meta/llama-3.2-11b-vision-instruct",
        verdict: "pass",
        flags: { variant: "thumb", is_physical_object: true, nsfw: 0, violence: 0.4, weapons: 0, notes: "" },
        reason: null,
        attempt: 1,
        latency_ms: 12,
        created_at: 0,
      },
    ];
    jest.mocked(getAdminQueue).mockImplementation(async (_token, options) => {
      if (options.status === "needs_review") return { items: [flagged], next_cursor: null };
      return { items: [], next_cursor: null };
    });

    const { toJSON, UNSAFE_getAllByProps } = render(
      <ToastProvider>
        <AdminPage />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });

    let tree = JSON.stringify(toJSON());
    expect(tree).toContain("flags: variant thumb · violence 0.4");
    expect(tree).not.toContain("is_physical_object");
    expect(tree).not.toContain("raw: {");

    await act(async () => {
      fireEvent.press(
        lastWithLabel(UNSAFE_getAllByProps({ accessibilityLabel: "Show raw flags" }), "Show raw flags"),
      );
      await flush();
    });

    tree = JSON.stringify(toJSON());
    expect(tree).toContain("is_physical_object");
    expect(tree).toContain("Hide raw");
  });

  // #286: none of the four Undo callbacks told the reducer the item came
  // back, so the queue kept showing it gone until a full reload. Restore's
  // undo is the one case with a single, well-known resulting status
  // (`hidden`), so it's fixed with a straight `reinsert` — this proves the
  // whole round trip: optimistic remove, Undo, item visible again with no
  // reload in between.
  it("Undo after Restore puts the item back in the Hidden tab without a reload", async () => {
    jest.mocked(getAdminQueue).mockImplementation(async (_token, options) => {
      if (options.status === "hidden") {
        return { items: [item("h", "Chipped mug")], next_cursor: null };
      }
      return { items: [], next_cursor: null };
    });
    jest.mocked(restoreListing).mockResolvedValue({} as never);

    const { toJSON, UNSAFE_getAllByProps } = render(
      <ToastProvider>
        <AdminPage />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });

    await act(async () => {
      fireEvent.press(lastWithLabel(UNSAFE_getAllByProps({ accessibilityLabel: "Hidden" }), "Hidden"));
      await flush();
    });
    expect(JSON.stringify(toJSON())).toContain("Chipped mug");

    await act(async () => {
      fireEvent.press(lastWithLabel(UNSAFE_getAllByProps({ accessibilityLabel: "Restore" }), "Restore"));
      await flush();
    });
    // Optimistic remove: gone from the Hidden tab the moment Restore fires.
    expect(JSON.stringify(toJSON())).not.toContain("Chipped mug");

    await act(async () => {
      fireEvent.press(lastWithLabel(UNSAFE_getAllByProps({ accessibilityLabel: "Undo" }), "Undo"));
      await flush();
    });

    expect(jest.mocked(hideListing)).toHaveBeenCalledWith("e2e-admin", "h");
    // Reinsert dispatched on the undo's own success — back without a reload.
    expect(JSON.stringify(toJSON())).toContain("Chipped mug");
  });
});

/**
 * #358 and #361 — the header area, the part of `/admin` drawn above the
 * queue. These do not assert "a heading is rendered"; they render the screen
 * under both themes and read back what each word is printed on, which is
 * the only form that could have failed before the fix: "Admin" and Forget
 * were constant ink in a bare `View` on the table, and in the first dark
 * frame of this route the heading measured near 1:1. Same method as
 * `test/app/mine/index.test.tsx` (#216), through `test/support/paper.ts`.
 */
describe("/admin header: paper and hierarchy (#358, #361)", () => {
  beforeEach(() => {
    mockAdminApi();
  });

  afterEach(() => {
    window.sessionStorage.clear();
    jest.clearAllMocks();
  });

  async function renderAdmin(mode: "light" | "dark"): Promise<Node | Node[]> {
    const { toJSON } = render(
      <ThemeProvider mode={mode}>
        <ToastProvider>
          <AdminPage />
        </ToastProvider>
      </ThemeProvider>,
    );
    await act(async () => {
      await flush();
    });
    return toJSON() as unknown as Node | Node[];
  }

  /** Does this host node carry exactly this word as its own text? Case-
   * insensitive because `Button` may shout its label. */
  function hasWord(node: Node, word: string): boolean {
    return (node.children ?? []).some((c) => typeof c === "string" && c.toLowerCase() === word.toLowerCase());
  }

  it.each(["light", "dark"] as const)("prints the Admin heading and Forget on paper, legibly, in %s mode", async (mode) => {
    const nodes = walk(await renderAdmin(mode));

    const heading = nodes.find(({ node }) => hasWord(node, "Admin"));
    const forget = nodes.find(({ node }) => hasWord(node, "Forget"));
    if (heading === undefined || forget === undefined) throw new Error("no Admin heading or Forget label in the tree");

    for (const { node, ancestors } of [heading, forget]) {
      const ground = paperUnder(node, ancestors);
      // The constant chrome tint, so the ratio below is the same number under
      // either lamp — the whole point of putting the words on paper.
      expect(ground).toBe(colorsLight.surface.toUpperCase());
      expect(contrastRatio(hexOf(styleOf(node).color), ground)).toBeGreaterThanOrEqual(AA);
    }
  });

  it("draws the section switch as underlined tabs above the stats strip, and the status filter as chips under a Queue eyebrow", async () => {
    const tree = await renderAdmin("light");
    const nodes = walk(tree);

    const tablist = (name: string): Node => {
      const hit = nodes.find(({ node }) => node.props.role === "tablist" && node.props["aria-label"] === name);
      if (hit === undefined) throw new Error(`no tablist named "${name}"`);
      return hit.node;
    };
    const tabsOf = (list: Node): Node[] => walk(list).map(({ node }) => node).filter((node) => node.props.role === "tab");

    // Both rows keep the roles and names `e2e/a11y.spec.ts`, `admin.spec.ts`
    // and `ux.spec.ts` find them by.
    const sectionTabs = tabsOf(tablist("Admin sections"));
    const statusTabs = tabsOf(tablist("Queue status"));
    expect(sectionTabs.map((t) => t.props["aria-label"])).toEqual(["Queue", "Observatory"]);
    expect(statusTabs.map((t) => t.props["aria-label"])).toEqual(["Needs review", "Hidden", "Pending", "Rejected"]);

    // The selected section tab wears the header's underline — a 2px stamp-red
    // rule and no fill; the selected status chip wears the tape-red wash and
    // an ink edge, never that rule. That is the difference a sighted
    // moderator gets, where before only the two `aria-label`s differed.
    const section = sectionTabs.find((t) => t.props["aria-selected"] === true);
    const status = statusTabs.find((t) => t.props["aria-selected"] === true);
    if (section === undefined || status === undefined) throw new Error("no selected tab in one of the rows");
    expect(section.props["aria-label"]).toBe("Queue");
    expect(status.props["aria-label"]).toBe("Needs review");

    expect(styleOf(section).borderBottomWidth).toBe("2px");
    expect(hexOf(styleOf(section).borderBottomColor)).toBe(colorsLight.accent.toUpperCase());
    expect(styleOf(section).backgroundColor).toBeUndefined();

    expect(hexOf(styleOf(status).backgroundColor)).toBe(colorsLight.accentSoft.toUpperCase());
    expect(hexOf(styleOf(status).borderBottomColor ?? styleOf(status).borderColor)).toBe(colorsLight.ink.toUpperCase());

    // And the two rows are no longer neighbours: the stats strip's "Today"
    // sits between the section switch and the queue's own filter, which now
    // has its own eyebrow — on paper, like every other word up here.
    const text = JSON.stringify(tree);
    expect(text.indexOf("Admin sections")).toBeLessThan(text.indexOf("Today"));
    expect(text.indexOf("Today")).toBeLessThan(text.indexOf("Queue status"));

    const eyebrow = nodes.find(({ node }) => node.props.role === "heading" && hasWord(node, "Queue"));
    if (eyebrow === undefined) throw new Error('no "Queue" eyebrow over the status filter');
    expect(paperUnder(eyebrow.node, eyebrow.ancestors)).toBe(colorsLight.surface.toUpperCase());
  });
});

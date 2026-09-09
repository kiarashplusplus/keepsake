import * as React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import type { PublicListing } from "@keepsake/contracts/listing";
import { measure, sectionRhythm } from "@keepsake/tokens/spacing";
import * as typography from "@keepsake/tokens/typography";
import { ToastProvider } from "@/ui/Toast";
import { getListing } from "@/api/listings";
import { ApiError } from "@/api/client";
import Item from "../../../app/item/[id]";

jest.mock("expo-router", () => {
  const ReactActual = jest.requireActual("react");
  return {
    useLocalSearchParams: () => ({ id: "listing-1" }),
    // `asChild` merges `href` onto the child, which is how a `Button` inside
    // a `Link` becomes a real `<a href>` (see `ButtonProps.href`). The mock
    // dropped the href entirely until #359, so nothing here could tell a
    // link-shaped button from one that navigates nowhere.
    Link: ({ children, asChild, href }: { children: React.ReactNode; asChild?: boolean; href?: string }) =>
      asChild && ReactActual.isValidElement(children)
        ? ReactActual.cloneElement(children as React.ReactElement, { href })
        : ReactActual.createElement(ReactActual.Fragment, null, children),
  };
});

jest.mock("@/api/listings", () => ({ getListing: jest.fn() }));

// `Sheet` renders an RN `Modal`, which react-native-web implements via
// `ReactDOM.createPortal` — react-test-renderer (this preset's renderer)
// doesn't support portals ("An invalid container has been provided"), so
// every test that needs to see a sheet's *contents* mocks the wrapper down
// to "render children when visible" and leaves Modal/focus-trap behavior to
// be exercised by Playwright against a real browser instead.
jest.mock("@/ui/Sheet", () => {
  const ReactActual = jest.requireActual("react");
  return {
    Sheet: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
      visible ? ReactActual.createElement(ReactActual.Fragment, null, children) : null,
  };
});

const listing: PublicListing = {
  id: "listing-1",
  title: "Brass compass",
  story: "It pointed the way on a trip I never finished, and now it should point someone else's.",
  category: "other",
  place_name: "Somerville",
  admin1: "MA",
  country: "US",
  status: "approved",
  photos: [
    {
      id: "photo-1",
      width: 800,
      height: 600,
      blurhash: "LKO2?U%2Tw=w]~RBVZRi};RPxuwH",
      url_full: "https://example.com/full.jpg",
      url_thumb: "https://example.com/thumb.jpg",
    },
  ],
  aspects: [],
  published_at: Date.now() - 60_000,
};

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

/**
 * Drives `useWindowDimensions()`, which is what #222's two-column branch is
 * keyed on. react-native-web's `Dimensions` reads
 * `document.documentElement.clientWidth/Height` and re-reads them on every
 * `window` `resize` event; jsdom does no layout, so those are a flat 0 and
 * every test in this file has always been rendering the narrow branch without
 * saying so. Defining the two properties and firing a real `resize` is enough
 * — no module mock, no fake `visualViewport`, and `Dimensions` picks the
 * values up through its own public path rather than us reaching into its
 * module state.
 *
 * `configurable: true` so the next call can redefine them; `beforeEach` puts
 * the phone width back so a test that forgets to set one is narrow, which is
 * the default this page had before the split existed.
 */
function setViewport(width: number, height: number): void {
  Object.defineProperty(document.documentElement, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: height, configurable: true });
  window.dispatchEvent(new Event("resize"));
}

/** The issue's own narrow frame, `docs/qa/baseline/ux-mobile/*`. */
const PHONE = [390, 844] as const;
/** The issue's own desktop frame — the one the title was cut by the fold on. */
const DESKTOP = [1280, 800] as const;

type Node = { props?: { style?: Record<string, unknown> }; children?: unknown };

/** Depth-first walk of a `toJSON()` tree (whose root is an array). */
function find(node: unknown, predicate: (n: Node) => boolean): Node | null {
  if (Array.isArray(node)) {
    for (const entry of node) {
      const hit = find(entry, predicate);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (node === null || typeof node !== "object") return null;
  const candidate = node as Node;
  if (predicate(candidate)) return candidate;
  return find(candidate.children, predicate);
}

function styleOf(node: Node): Record<string, unknown> {
  return node.props?.style ?? {};
}

/** react-native-web serialises lengths with units, so 1100 -> "1100px". */
function px(value: number): string {
  return `${value}px`;
}

/**
 * Is the action carrying this label the underlined one? `Button`'s `link`
 * variant is the only thing on this page that draws a bottom border, so the
 * first node that both has one and contains the label is that button. This
 * is how #359's actual complaint is stated as an assertion: not "is Share
 * present" (it always was) but "is Share the first, loudest, underlined
 * thing offered to a stranger on a keepsake nobody can have".
 */
function underlined(tree: unknown, label: string): boolean {
  return (
    find(tree, (n) => {
      const width = styleOf(n)["borderBottomWidth"];
      if (width === undefined || width === 0 || width === "0px") return false;
      return JSON.stringify(n).includes(label);
    }) !== null
  );
}

describe("item/[id]", () => {
  beforeEach(() => {
    jest.mocked(getListing).mockReset();
    setViewport(...PHONE);
  });

  /**
   * Issue #135. `PublicListing.aspects` was populated and carried in the API
   * response for two issues before any view rendered one, so a visitor to
   * the first real production listing saw the single word "OTHER" for an
   * object printed KASTKING / SUPER POWER / 30 LBS 327 YDS. Asserted on the
   * page, not on the data — the data was never the thing that was wrong.
   */
  it("renders the aspects the API returned", async () => {
    jest.mocked(getListing).mockResolvedValue({
      ...listing,
      aspects: [
        { name: "brand", value: "KastKing" },
        { name: "size", value: "30 lbs 327 yds" },
      ],
    });

    const { toJSON } = render(
      <ToastProvider>
        <Item />
      </ToastProvider>,
    );
    await act(flush);

    const json = JSON.stringify(toJSON());
    expect(json).toContain("brand");
    expect(json).toContain("KastKing");
    expect(json).toContain("30 lbs 327 yds");
  });

  it("renders the story and opens the RequestSheet from 'I'd love this'", async () => {
    jest.mocked(getListing).mockResolvedValue(listing);

    const { toJSON, UNSAFE_getByProps } = render(
      <ToastProvider>
        <Item />
      </ToastProvider>,
    );

    await act(async () => {
      await flush();
    });

    expect(JSON.stringify(toJSON())).toContain("It pointed the way on a trip I never finished");

    const requestButton = UNSAFE_getByProps({ accessibilityLabel: "I'd love this" });
    await act(async () => {
      fireEvent.press(requestButton);
      await flush();
    });

    expect(JSON.stringify(toJSON())).toContain("Tell them why it should be yours");
  });

  it("hides the request button and shows a Given banner for a given listing", async () => {
    jest.mocked(getListing).mockResolvedValue({ ...listing, status: "given" });

    const { toJSON, UNSAFE_queryAllByProps } = render(
      <ToastProvider>
        <Item />
      </ToastProvider>,
    );

    await act(async () => {
      await flush();
    });

    expect(JSON.stringify(toJSON())).toContain("Given");
    expect(UNSAFE_queryAllByProps({ accessibilityLabel: "I'd love this" })).toHaveLength(0);
  });

  /**
   * Issue #359. A given keepsake is a live page — it is what a stranger
   * reaches from an old link or a card that unfurled in a group chat — and
   * the only thing it said about being over was a rubber stamp that, at
   * desktop widths, sits in the other column entirely. Removing "I'd love
   * this" also promoted Share into the vacated first slot, so the loudest
   * offer on the page was to pass the link on.
   */
  describe("a given keepsake says so, and points onward (#359)", () => {
    const givenListing: PublicListing = { ...listing, status: "given", given_at: Date.now() - 3 * 86_400_000 };

    async function renderGiven(listingToServe: PublicListing = givenListing): Promise<ReturnType<typeof render>> {
      jest.mocked(getListing).mockResolvedValue(listingToServe);
      const utils = render(
        <ToastProvider>
          <Item />
        </ToastProvider>,
      );
      await act(flush);
      return utils;
    }

    it("says it in words, in the story column, not only as a stamp", async () => {
      const { toJSON } = await renderGiven();

      expect(JSON.stringify(toJSON())).toContain("This one has found a home.");
    });

    it("offers the feed as a real link", async () => {
      const { UNSAFE_getByProps } = await renderGiven();

      const onward = UNSAFE_getByProps({ accessibilityLabel: "See what else is nearby" });
      // A crawler can follow it, a middle-click opens it in a tab, and a
      // screen reader announces it as a link — see `ButtonProps.href`.
      expect(onward.props.href).toBe("/");
      expect(onward.props.accessibilityRole).toBe("link");
    });

    it("gives that link the underline Share used to inherit", async () => {
      const { toJSON } = await renderGiven();
      const tree = toJSON();

      expect(underlined(tree, "See what else is nearby")).toBe(true);
      // Still on the page for anyone who wants to show someone the story —
      // just no longer the action the page leads with.
      expect(JSON.stringify(tree)).toContain("Share");
      expect(underlined(tree, "Share")).toBe(false);
    });

    it("leaves the live page exactly as it was: Share underlined, no onward line", async () => {
      const { toJSON, UNSAFE_queryAllByProps } = await renderGiven(listing);
      const tree = toJSON();

      expect(underlined(tree, "Share")).toBe(true);
      expect(JSON.stringify(tree)).not.toContain("This one has found a home.");
      expect(UNSAFE_queryAllByProps({ accessibilityLabel: "See what else is nearby" })).toHaveLength(0);
      expect(UNSAFE_queryAllByProps({ accessibilityLabel: "I'd love this" }).length).toBeGreaterThan(0);
    });

    it("dates the giving rather than the posting", async () => {
      const { toJSON } = await renderGiven();
      const rendered = JSON.stringify(toJSON());

      expect(rendered).toContain("given 3 d ago");
      expect(rendered).not.toContain("posted ");
    });

    /**
     * `given_at` is optional on `PublicListing` and `serialize.ts` omits the
     * key when the column is null, which is the shape of any row marked given
     * before that column existed. The line falls back rather than rendering
     * "given undefined".
     */
    it("falls back to the publish date when given_at never made it into the row", async () => {
      const withoutGivenAt: PublicListing = { ...listing, status: "given" };
      const { toJSON } = await renderGiven(withoutGivenAt);
      const rendered = JSON.stringify(toJSON());

      expect(rendered).toContain("posted ");
      expect(rendered).not.toContain("given undefined");
    });
  });

  /**
   * Issue #222. At 1280x800 the print filled the viewport, so the title was
   * cut by the fold and the story sat below it — on a page whose whole
   * proposition is a photograph and the story attached to it, you could not
   * see both at once. Desktop now splits into print-left / story-right.
   *
   * These assert on the rendered tree, so what they can prove is structural:
   * which measure the page is on, that the two blocks are in one row and in
   * that order, and that the print's own width cap is out of the way inside
   * its column. That the result *looks* right at 1280x800 is a job for
   * `e2e/ux.spec.ts`'s desktop frame, not for react-test-renderer.
   */
  describe("desktop two-column layout (#222)", () => {
    /**
     * The measure the page itself is laid out on. Found by style rather than
     * by a `testID` because `Page` renders TWO `ReadableWidth`s — the content
     * and `AppFooter`, which is always `grid` — so "is 1100px anywhere in the
     * tree" is true at every width and proves nothing. The content one is the
     * only node carrying both a measure and the page's own vertical rhythm.
     */
    function pageMeasure(tree: unknown): unknown {
      const node = find(tree, (n) => styleOf(n)["paddingTop"] === px(sectionRhythm.normal) && styleOf(n)["maxWidth"] !== undefined);
      return node === null ? null : styleOf(node)["maxWidth"];
    }

    /** The print/story row, which only exists in the two-column layout. */
    function splitRow(tree: unknown): Node | null {
      return find(tree, (n) => styleOf(n)["flexDirection"] === "row" && styleOf(n)["alignItems"] === "flex-start");
    }

    async function renderAt(width: number, height: number): Promise<ReturnType<typeof render>> {
      setViewport(width, height);
      const utils = render(
        <ToastProvider>
          <Item />
        </ToastProvider>,
      );
      await act(flush);
      return utils;
    }

    it("puts the photograph and the story side by side, in that order", async () => {
      jest.mocked(getListing).mockResolvedValue(listing);

      const { toJSON } = await renderAt(...DESKTOP);
      const tree = toJSON();

      expect(pageMeasure(tree)).toBe(px(measure.grid));

      const row = splitRow(tree);
      expect(row).not.toBeNull();
      const columns = row?.children;
      expect(Array.isArray(columns) ? columns : []).toHaveLength(2);

      // Left is the print (the carousel's 4:3 box is the only `aspectRatio`
      // on this page); right is the story. This is the whole issue: both are
      // on screen, and the photograph is the thing you read the page from.
      const [printColumn, storyColumn] = columns as [unknown, unknown];
      expect(JSON.stringify(printColumn)).toContain("aspectRatio");
      expect(JSON.stringify(storyColumn)).toContain("It pointed the way on a trip I never finished");

      // The story column keeps its whole `Card` treatment.
      const story = JSON.stringify(storyColumn);
      expect(story).toContain("Brass compass");
      expect(story).toContain("pencil-underline.svg"); // the `PencilRule`
      expect(story).toContain("Somerville, MA · posted"); // the meta line
      expect(story).toContain("Share");
      expect(story).toContain("Report");
    });

    it("drops the carousel's 560px cap so the print fills its column", async () => {
      jest.mocked(getListing).mockResolvedValue(listing);

      const { toJSON } = await renderAt(...DESKTOP);
      expect(JSON.stringify(toJSON())).not.toContain(`"maxWidth":"${px(560)}"`);
    });

    it("keeps the single-column prose layout on a phone", async () => {
      jest.mocked(getListing).mockResolvedValue(listing);

      const { toJSON } = await renderAt(...PHONE);
      const tree = toJSON();

      expect(pageMeasure(tree)).toBe(px(measure.prose));
      expect(splitRow(tree)).toBeNull();
      // ...and the print is still capped exactly as it always was.
      expect(JSON.stringify(tree)).toContain(`"maxWidth":"${px(560)}"`);
    });

    /**
     * `TWO_COLUMN_BREAKPOINT` (1024) and `WIDE_TITLE_BREAKPOINT` (820) are
     * different numbers on purpose: splitting at 820 would leave each column
     * around 378px, the phone column twice over. The cheapest way for that to
     * rot is for someone to collapse them into one constant, so pin a width
     * between them — big type, still one column.
     */
    it("uses the wide title but stays single-column between the two breakpoints", async () => {
      jest.mocked(getListing).mockResolvedValue(listing);

      const { toJSON } = await renderAt(900, 800);
      const tree = toJSON();

      expect(pageMeasure(tree)).toBe(px(measure.prose));
      expect(splitRow(tree)).toBeNull();
      expect(find(tree, (n) => styleOf(n)["fontSize"] === px(typography.type.displayXl.fontSize))).not.toBeNull();
    });

    it("still stamps a given listing, in the print column, when split", async () => {
      jest.mocked(getListing).mockResolvedValue({ ...listing, status: "given" });

      const { toJSON, UNSAFE_queryAllByProps } = await renderAt(...DESKTOP);

      const printColumn = (splitRow(toJSON())?.children as unknown[])[0];
      expect(JSON.stringify(printColumn)).toContain("Given");
      expect(UNSAFE_queryAllByProps({ accessibilityLabel: "I'd love this" })).toHaveLength(0);
    });

    /**
     * The other half of #359, and the reason the words are not enough if they
     * travel with the stamp: split, the stamp is in the left column and a
     * reader's eye is in the right one. The sentence and the way out both
     * have to be on the card.
     */
    it("puts the words and the way onward in the story column, beside the stamp", async () => {
      jest.mocked(getListing).mockResolvedValue({ ...listing, status: "given", given_at: Date.now() - 3 * 86_400_000 });

      const { toJSON } = await renderAt(...DESKTOP);
      const storyColumn = (splitRow(toJSON())?.children as unknown[])[1];
      const story = JSON.stringify(storyColumn);

      expect(story).toContain("This one has found a home.");
      expect(story).toContain("See what else is nearby");
      expect(story).toContain("Somerville, MA · given 3 d ago");
      expect(underlined(storyColumn, "See what else is nearby")).toBe(true);
      expect(underlined(storyColumn, "Share")).toBe(false);
    });

    it("opens the RequestSheet from the story column", async () => {
      jest.mocked(getListing).mockResolvedValue(listing);

      const { toJSON, UNSAFE_getByProps } = await renderAt(...DESKTOP);

      await act(async () => {
        fireEvent.press(UNSAFE_getByProps({ accessibilityLabel: "I'd love this" }));
        await flush();
      });

      expect(JSON.stringify(toJSON())).toContain("Tell them why it should be yours");
    });

    /**
     * The three branches without a listing in them deliberately stay on the
     * prose measure at every width: there is no second column to put anything
     * in, and an empty state stretched across 1100px is a wider nothing, not
     * a fuller page.
     */
    it("leaves the not-found branch on the prose measure at desktop width", async () => {
      jest.mocked(getListing).mockRejectedValue(new ApiError("not_found", "Not found", 404));

      const { toJSON } = await renderAt(...DESKTOP);

      expect(JSON.stringify(toJSON())).toContain("That keepsake isn");
      expect(pageMeasure(toJSON())).toBe(px(measure.prose));
    });

    it("leaves the error branch on the prose measure at desktop width", async () => {
      jest.mocked(getListing).mockRejectedValue(new ApiError("internal", "Something broke", 500));

      const { toJSON } = await renderAt(...DESKTOP);

      expect(JSON.stringify(toJSON())).toContain("Something broke");
      expect(pageMeasure(toJSON())).toBe(px(measure.prose));
    });
  });
});

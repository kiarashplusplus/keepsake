import * as React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import type { OwnerListing } from "@keepsake/contracts/listing";
import { clampCardAspectRatio } from "@/lib/masonry";
import { storyExcerpt } from "@/lib/storyExcerpt";
import { ToastProvider } from "@/ui/Toast";
import { GiveDraftProvider } from "@/features/give/GiveDraftContext";
import { GIVE_DRAFT_INITIAL, GIVE_DRAFT_STORAGE_KEY, serializeGiveDraft } from "@/features/give/giveDraft";
import { createListing } from "@/api/listings";
import { getMyListing } from "@/api/me";
import GiveReview from "../../../app/give/review";

// `jest.mock` calls are hoisted above these imports by babel-plugin-jest-hoist
// at transform time, so writing the mocked modules' imports in normal
// top-of-file order still resolves to the mock.
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

jest.mock("@/api/listings", () => ({
  createListing: jest.fn(),
  updateListing: jest.fn(),
}));

jest.mock("@/api/me", () => ({
  getMyListing: jest.fn(),
}));

/** react-native-web renders to DOM nodes whose dynamic styles land inline;
 * these two read them back the way `test/ui/TableHeading.test.tsx` does. */
type Node = { type: string; props: Record<string, unknown>; children: (Node | string)[] | null };

function flatten(node: Node | Node[] | string | null | undefined): Node[] {
  // Three shapes reach here. `null`/`undefined` children are real (`Print`
  // renders its tape corners conditionally, and a branch that renders
  // nothing still occupies a slot), and `toJSON()` itself returns an ARRAY
  // when the tree has more than one root — which this one does, since
  // `ToastProvider` renders the screen and the toast host as siblings.
  if (node === null || node === undefined || typeof node === "string") return [];
  if (Array.isArray(node)) return node.flatMap(flatten);
  return [node, ...(node.children ?? []).flatMap(flatten)];
}

function styleOf(node: Node): Record<string, string | undefined> {
  return ((node.props ?? {}).style ?? {}) as Record<string, string | undefined>;
}

const baseListing: OwnerListing = {
  id: "01LISTINGAAAAAAAAAAAAAAAA",
  title: "A hand-thrown mug",
  story: "My grandmother made this every morning for forty years, and I finally have to let it go.",
  category: "home_kitchen",
  place_name: "Somerville",
  admin1: "MA",
  country: "US",
  postal_code: "02144",
  status: "pending",
  photos: [],
  aspects: [],
  published_at: 0,
  moderation_reason: null,
  request_count: 0,
  chosen_request_id: null,
  version: 1,
  created_at: 0,
  updated_at: 0,
  held: true,
  category_chosen_at: null,
};

function seedDraft(): void {
  window.sessionStorage.setItem(
    GIVE_DRAFT_STORAGE_KEY,
    serializeGiveDraft({
      ...GIVE_DRAFT_INITIAL,
      title: baseListing.title,
      story: baseListing.story,
      category: baseListing.category,
      country: baseListing.country,
      postalCode: "02144",
      photos: [
        {
          clientId: "p1",
          id: "01PHOTOAAAAAAAAAAAAAAAAAA",
          objectUrl: null,
          width: 800,
          height: 600,
          blurhash: "LKO2?U%2Tw=w]~RBVZRi};RPxuwH",
          status: "done",
          error: null,
          errorCode: null,
          canRetry: false,
        },
      ],
    }),
  );
}

function renderReview() {
  return render(
    <ToastProvider>
      <GiveDraftProvider>
        <GiveReview />
      </GiveDraftProvider>
    </ToastProvider>,
  );
}

describe("give/review", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    jest.mocked(createListing).mockReset();
    jest.mocked(getMyListing).mockReset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("submits, then polls from pending to approved and shows the live state", async () => {
    seedDraft();
    jest.mocked(createListing).mockResolvedValue(baseListing);
    jest.mocked(getMyListing).mockResolvedValue({
      ...baseListing,
      status: "approved",
      held: false,
      requests: [],
      staleness: { reasons: [], waiting_since: null },
      moderation: { status: "approved", held: false },
    });

    const { toJSON, getByLabelText } = renderReview();

    // Let Turnstile's no-site-key effect report `unconfigured` so Submit's
    // Turnstile gate is satisfied.
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.changeText(getByLabelText("Date of birth"), "1990-01-01");

    // By label, not by `accessibilityRole: "button"`: since #221 moved the
    // legal footer inside `ui/Page`, every screen renders a second button
    // ("Privacy choices") and the role alone stopped identifying this one.
    const submitButton = getByLabelText("Give it");
    await act(async () => {
      fireEvent.press(submitButton);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(jest.mocked(createListing)).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(toJSON())).toContain("Taking a look");

    // First poll tick resolves to "approved".
    await act(async () => {
      jest.advanceTimersByTime(3000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(JSON.stringify(toJSON())).toContain("It's live.");
  });

  it("shows the rejection reason and an Edit action when the listing is rejected", async () => {
    seedDraft();
    jest.mocked(createListing).mockResolvedValue(baseListing);
    jest.mocked(getMyListing).mockResolvedValue({
      ...baseListing,
      status: "rejected",
      moderation_reason: "contact_in_story",
      held: false,
      requests: [],
      staleness: { reasons: [], waiting_since: null },
      moderation: { status: "rejected", reason: "contact_in_story", held: false },
    });

    const { toJSON, getByLabelText } = renderReview();

    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.changeText(getByLabelText("Date of birth"), "1990-01-01");

    // By label, not by `accessibilityRole: "button"`: since #221 moved the
    // legal footer inside `ui/Page`, every screen renders a second button
    // ("Privacy choices") and the role alone stopped identifying this one.
    const submitButton = getByLabelText("Give it");
    await act(async () => {
      fireEvent.press(submitButton);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      jest.advanceTimersByTime(3000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(JSON.stringify(toJSON())).toContain("Keep contact details out of the story");
  });

  // Issue #296: every earlier step validates its own field before letting
  // the giver continue — this step didn't, so a giver who reaches
  // `/give/review` directly (a typed/bookmarked URL, or browser
  // back/forward across the flow) without ever passing through details or
  // story used to see "Give it" enabled with a title and story the server
  // was always going to reject, wasting a single-use Turnstile token.
  it("GUARD: disables Give it when the draft has no title, even with photos and age gate satisfied", async () => {
    window.sessionStorage.setItem(
      GIVE_DRAFT_STORAGE_KEY,
      serializeGiveDraft({
        ...GIVE_DRAFT_INITIAL,
        story: baseListing.story,
        title: "", // never reached details.tsx
        category: baseListing.category,
        country: baseListing.country,
        postalCode: "02144",
        photos: [
          {
            clientId: "p1",
            id: "01PHOTOAAAAAAAAAAAAAAAAAA",
            objectUrl: null,
            width: 800,
            height: 600,
            blurhash: "LKO2?U%2Tw=w]~RBVZRi};RPxuwH",
            status: "done",
            error: null,
            errorCode: null,
            canRetry: false,
          },
        ],
      }),
    );

    const { getByLabelText } = renderReview();
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.changeText(getByLabelText("Date of birth"), "1990-01-01");

    await act(async () => {
      fireEvent.press(getByLabelText("Give it"));
      await Promise.resolve();
    });

    expect(jest.mocked(createListing)).not.toHaveBeenCalled();
  });

  it("GUARD: disables Give it when the draft's story is under the schema's minimum", async () => {
    window.sessionStorage.setItem(
      GIVE_DRAFT_STORAGE_KEY,
      serializeGiveDraft({
        ...GIVE_DRAFT_INITIAL,
        title: baseListing.title,
        story: "too short", // never reached story.tsx
        category: baseListing.category,
        country: baseListing.country,
        postalCode: "02144",
        photos: [
          {
            clientId: "p1",
            id: "01PHOTOAAAAAAAAAAAAAAAAAA",
            objectUrl: null,
            width: 800,
            height: 600,
            blurhash: "LKO2?U%2Tw=w]~RBVZRi};RPxuwH",
            status: "done",
            error: null,
            errorCode: null,
            canRetry: false,
          },
        ],
      }),
    );

    const { getByLabelText } = renderReview();
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.changeText(getByLabelText("Date of birth"), "1990-01-01");

    await act(async () => {
      fireEvent.press(getByLabelText("Give it"));
      await Promise.resolve();
    });

    expect(jest.mocked(createListing)).not.toHaveBeenCalled();
  });

  it("enables Give it once title, story, a photo and the age gate are all satisfied", async () => {
    seedDraft();
    jest.mocked(createListing).mockResolvedValue(baseListing);

    const { getByLabelText } = renderReview();
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.changeText(getByLabelText("Date of birth"), "1990-01-01");

    await act(async () => {
      fireEvent.press(getByLabelText("Give it"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(jest.mocked(createListing)).toHaveBeenCalledTimes(1);
  });

  /**
   * Issue #218. The review print used to render the cover as a fixed 96x96
   * thumbnail pinned to the top-left of a full-width frame, with most of the
   * print empty beside it — so the one screen whose entire job is "this is
   * what you are about to publish" was the one screen that did not look like
   * the published card.
   *
   * This asserts the geometry, not the words: the photo's box fills the
   * print's width and carries the cover's own clamped aspect ratio, exactly
   * as `src/features/feed/ListingCard.tsx` does. Put the 96x96 square back
   * and both halves fail — the width is a pixel count again and the ratio is
   * gone. `clampCardAspectRatio` is imported rather than restated so this
   * cannot quietly agree with a copy of the rule that has since drifted.
   */
  it("renders the cover the way the feed card will: full width, at the photo's own aspect ratio", () => {
    seedDraft();
    const { toJSON } = renderReview();

    // The seeded cover is 800x600 — a 4:3 landscape, inside the band
    // `clampCardAspectRatio` allows, so it survives the clamp unchanged.
    const expected = clampCardAspectRatio(800, 600);
    expect(expected).toBeCloseTo(4 / 3, 6);

    const photoBox = flatten(toJSON() as unknown as Node).find((node) => styleOf(node).aspectRatio !== undefined);
    if (photoBox === undefined) throw new Error("no node in the review print carries an aspectRatio");

    expect(Number(styleOf(photoBox).aspectRatio)).toBeCloseTo(expected, 6);
    expect(styleOf(photoBox).width).toBe("100%");
  });

  function seedLongStoryDraft(longStory: string): void {
    window.sessionStorage.setItem(
      GIVE_DRAFT_STORAGE_KEY,
      serializeGiveDraft({
        ...GIVE_DRAFT_INITIAL,
        title: baseListing.title,
        story: longStory,
        category: baseListing.category,
        country: baseListing.country,
        postalCode: "02144",
        photos: [
          {
            clientId: "p1",
            id: "01PHOTOAAAAAAAAAAAAAAAAAA",
            objectUrl: null,
            width: 800,
            height: 600,
            blurhash: "LKO2?U%2Tw=w]~RBVZRi};RPxuwH",
            status: "done",
            error: null,
            errorCode: null,
            canRetry: false,
          },
        ],
      }),
    );
  }

  const LONG_STORY =
    "It sat on my mother's table every Sunday of my childhood and has traveled with our family through four house moves since. " +
    "I finally have to let it go because there is no room for it in my new apartment, but I want it to go to someone who will love it the way we did.";

  /**
   * Issue #373 finding 3 (mobile), first half. The review card is a
   * deliberate mirror of `src/features/feed/ListingCard.tsx` — same excerpt
   * cut, same `numberOfLines={2}` — because its job is showing what a
   * stranger scrolling the table will actually see, cut included. An
   * earlier version of this fix removed the clamp from the card itself,
   * which meant the giver could no longer notice *that* their story gets
   * cut, only read a full story nowhere resembling any real card. Revert to
   * that (drop `numberOfLines={2}`/`storyExcerpt` from the print) and this
   * fails: no node in the print carries the 2-line clamp any more.
   */
  it("keeps the feed's excerpt cut on the review card itself", () => {
    seedLongStoryDraft(LONG_STORY);
    const { toJSON } = renderReview();

    const excerptNode = flatten(toJSON() as unknown as Node).find(
      (node) =>
        Array.isArray(node.children) &&
        node.children.some((child) => typeof child === "string" && child === storyExcerpt(LONG_STORY)),
    );
    if (excerptNode === undefined) throw new Error("no node renders the card's story excerpt");
    // react-native-web turns `numberOfLines` into a `-webkit-line-clamp`
    // rule on the node's own style rather than passing it through as a DOM
    // prop — there is no `numberOfLines` attribute to read back.
    expect(Number(styleOf(excerptNode).WebkitLineClamp)).toBe(2);
  });

  /**
   * Issue #373 finding 3 (mobile), second half. Before this, the full story
   * appeared nowhere on this step at all — `docs/qa/baseline/ux-mobile/
   * give-5-review-submit.jpg` shows the date-of-birth field sitting directly
   * under the card with nothing between them. A story past the card's two
   * lines was simply gone until it was already live; the baseline caught
   * one cut mid-sentence. Revert the fix (remove the full-story block below
   * the print) and this fails: nothing in the tree carries the story's back
   * half un-clamped.
   */
  it("shows the full story below the card, unclamped, for proofreading", () => {
    seedLongStoryDraft(LONG_STORY);
    const { toJSON } = renderReview();

    const rendered = JSON.stringify(toJSON());
    expect(rendered).toContain("someone who will love it the way we did");

    const fullStoryNode = flatten(toJSON() as unknown as Node).find(
      (node) => Array.isArray(node.children) && node.children.some((child) => typeof child === "string" && child === LONG_STORY),
    );
    if (fullStoryNode === undefined) throw new Error("no node renders the full, unclamped story");
    expect(styleOf(fullStoryNode).WebkitLineClamp).toBeUndefined();
  });

  /**
   * Issue #373 finding 3 (desktop). The print used to be
   * `alignSelf: "stretch"` — full prose-measure width (720px), nearly 3x a
   * real feed card at that container width (a masonry column tops out
   * around 250px, see `masonry.ts`'s breakpoints). At 1280px that stretched
   * a portrait cover tall enough to push the title, the story, the age gate
   * and "Give it" below the fold entirely. Revert the fix (bring back
   * `alignSelf: "stretch"` with no `maxWidth`) and this fails.
   *
   * Anchored on `data-ks-print="drop"` — the attribute `Print.web.tsx`'s
   * entrance animation selects, and the only one in this tree — rather than
   * "the first node with a `maxWidth`": `Page`'s prose measure carries one
   * too, and an unrelated change there would let that satisfy a looser
   * query without ever looking at the print.
   */
  it("caps the review print's width instead of letting it stretch to the full measure", () => {
    seedDraft();
    const { toJSON } = renderReview();

    const printNode = flatten(toJSON() as unknown as Node).find((node) => node.props["data-ks-print"] === "drop");
    if (printNode === undefined) throw new Error("no node in the tree is the review print");

    // react-native-web renders resolved CSS length strings ("340px"), not
    // the raw numbers passed in — hence `parseFloat` rather than `Number`.
    expect(parseFloat(styleOf(printNode).maxWidth ?? "")).toBeLessThan(500);
    expect(styleOf(printNode).alignSelf).not.toBe("stretch");
  });
});

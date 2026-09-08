/**
 * The story step's two #217/#224 properties, both of which are about
 * geometry and colour rather than words — and neither of which any existing
 * check could have caught. `e2e/give.spec.ts` clicks `Continue` through
 * `onScreen(page, "Continue").click()`, which succeeds just as happily on a
 * button scrolled out of view as on one the giver can see, and no scan had
 * ever measured the photo-condition note's ink against the fill underneath
 * it in either theme.
 */
import * as React from "react";
import { render } from "@testing-library/react-native";
import { contrastRatio } from "@keepsake/tokens/contrast";
import { colorsLight } from "@keepsake/tokens/colors";
import { space } from "@keepsake/tokens/spacing";
import { type } from "@keepsake/tokens/typography";
import { ThemeProvider } from "@/ui/theme";
import { GiveDraftProvider } from "@/features/give/GiveDraftContext";
import { GIVE_DRAFT_INITIAL, GIVE_DRAFT_STORAGE_KEY, serializeGiveDraft } from "@/features/give/giveDraft";
import GiveStory from "../../../app/give/story";

// `jest.mock` calls are hoisted above these imports by babel-plugin-jest-hoist
// at transform time, so writing the mocked modules' imports in normal
// top-of-file order still resolves to the mock.
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

// `IconButton` (the note's dismiss ×) pulls in `@expo/vector-icons`, whose
// dependency chain reaches `expo-font`'s untranspiled ESM — the same class of
// problem `test/mocks/expoImage.tsx` exists for, and the same answer: nothing
// here is about a glyph. `react` is required lazily inside the factory
// because a `jest.mock` factory may not close over an out-of-scope binding.
jest.mock("@expo/vector-icons", () => {
  const react = jest.requireActual("react") as typeof import("react");
  const { View } = jest.requireActual("react-native") as typeof import("react-native");
  return { Ionicons: (props: Record<string, unknown>) => react.createElement(View, props) };
});

/** WCAG AA for body-sized text, the bar `packages/tokens` holds itself to. */
const AA = 4.5;

/** The story field's resting height on a narrow viewport: four lines of
 * `type.bodyLg` plus `TextArea`'s own padding, restated from the tokens here
 * rather than hard-coded so a re-tuned type scale moves both together. */
const NARROW_RESTING_HEIGHT = 4 * type.bodyLg.lineHeight + 2 * space.lg;

type Node = { type: string; props: Record<string, unknown>; children: (Node | string)[] | null };

function flatten(node: Node | Node[] | string | null | undefined): Node[] {
  // `toJSON()` returns an ARRAY when the tree has more than one root, and
  // `null` children are real (every conditional branch that renders nothing
  // still occupies a slot).
  if (node === null || node === undefined || typeof node === "string") return [];
  if (Array.isArray(node)) return node.flatMap(flatten);
  return [node, ...(node.children ?? []).flatMap(flatten)];
}

function styleOf(node: Node): Record<string, string | undefined> {
  return ((node.props ?? {}).style ?? {}) as Record<string, string | undefined>;
}

/** react-native-web resolves every token to `rgba(r,g,b,a)` before it reaches
 * the tree, and `contrastRatio()` speaks `#RRGGBB` only. Alpha is asserted to
 * be 1 rather than composited away: a translucent note over a fill would be
 * the same bug wearing a different hat. Lifted from
 * `test/ui/TableHeading.test.tsx`, which measures the same kind of claim. */
function hexOf(color: string): string {
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(color);
  if (m === null) throw new Error(`not an rgba() colour: ${color}`);
  if (Number(m[4]) !== 1) throw new Error(`${color} is translucent; contrast off a composited colour is a guess`);
  return `#${[m[1], m[2], m[3]].map((c) => Number(c).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

const CONDITION = "a small chip near the handle";
const NOTE_TEXT = `Your photo shows ${CONDITION}. Worth a line?`;

/** A draft whose cover photo has a suggestion carrying a `condition`, and
 * whose `appliedSuggestionPhotoId` still points at that same cover — the
 * exact three-way agreement `story.tsx` requires before it will show the
 * photo-condition note at all. */
function seedDraftWithConditionNote(): void {
  const photoId = "01PHOTOAAAAAAAAAAAAAAAAAA";
  window.sessionStorage.setItem(
    GIVE_DRAFT_STORAGE_KEY,
    serializeGiveDraft({
      ...GIVE_DRAFT_INITIAL,
      photos: [
        {
          clientId: "p1",
          id: photoId,
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
      appliedSuggestionPhotoId: photoId,
      suggestions: {
        [photoId]: {
          subject: "a ceramic mug",
          markings: "",
          title: "A hand-thrown mug",
          category: "home_kitchen",
          condition: CONDITION,
          aspects: [],
        },
      },
    }),
  );
}

function renderStory(mode: "light" | "dark" = "light") {
  const { toJSON } = render(
    <ThemeProvider mode={mode}>
      <GiveDraftProvider>
        <GiveStory />
      </GiveDraftProvider>
    </ThemeProvider>,
  );
  return flatten(toJSON() as unknown as Node);
}

describe("give/story", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  /**
   * Issue #217: a flat 220px story field pushed `Continue` off the bottom of
   * the card at 390x844 — the giver saw an 18px red sliver with no word in
   * it. jsdom lays nothing out and reports a window width of 0, so
   * `useWindowDimensions()` puts every test on the narrow side of the
   * breakpoint; that is the branch this pins, and it is the branch the issue
   * is about. Restore `minHeight={220}` and this fails.
   */
  it("rests four lines tall on a narrow viewport", () => {
    const field = renderStory().find((node) => node.type === "textarea");
    if (field === undefined) throw new Error("no textarea in the story step");

    expect(styleOf(field).minHeight).toBe(`${NARROW_RESTING_HEIGHT}px`);
    expect(NARROW_RESTING_HEIGHT).toBeLessThan(220);

    // And nothing has pinned it to that height: the field is free to grow
    // past its resting size once there is something to grow for. (Under
    // jsdom `scrollHeight` is always 0, so it never actually does here —
    // which is exactly why `minHeight` is what a unit test can assert.)
    expect(styleOf(field).height).toBeUndefined();
  });

  /**
   * Issue #224. The note used to sit in a `Sunken` — a well filled with
   * `tableEdge`, one of the handful of tokens that really does flip between
   * light and dark (#B89D74 / #1C140F) while every ink colour stays
   * constant. `textSecondary` on it measured 2.96:1 in light and 2.37:1 in
   * dark: the lowest-contrast text on the screen, in both themes at once.
   *
   * Both modes are rendered because the bug was *worse* in the one nobody
   * looked at, and the ground is read out of the tree rather than assumed —
   * put the note back in a `Sunken` and the fill it reports flips, both
   * ratios drop under AA, and the last assertion fails outright.
   */
  it.each(["light", "dark"] as const)("keeps the photo-condition note readable on %s mode", (mode) => {
    seedDraftWithConditionNote();
    const nodes = renderStory(mode);

    const note = nodes.find((node) => (node.children ?? []).join("") === NOTE_TEXT);
    if (note === undefined) throw new Error("the photo-condition note is not on the screen");

    // The ground is whatever the nearest ancestor actually painted. The note
    // itself paints nothing — that is the fix — so this walks back up to the
    // `Card`'s own fill.
    const ground = nodes.filter((node) => styleOf(node).backgroundColor !== undefined && flatten(node).includes(note)).pop();
    if (ground === undefined) throw new Error("the note sits on nothing at all");

    expect(styleOf(note).backgroundColor).toBeUndefined();
    expect(contrastRatio(hexOf(styleOf(note).color ?? ""), hexOf(styleOf(ground).backgroundColor ?? ""))).toBeGreaterThanOrEqual(AA);

    // `surface` is one of the constant tokens, so light and dark assert the
    // same hex here. That is the whole argument: a note on the card's own
    // paper is measured once and holds in both themes, where a note in a
    // well has to clear two very different grounds and cleared neither.
    expect(hexOf(styleOf(ground).backgroundColor ?? "")).toBe(colorsLight.surface.toUpperCase());
  });
});

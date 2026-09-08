/**
 * The dashboard's group headings ("Reviewing", "Live", …) — issue #216.
 *
 * These used to be a bare `Eyebrow` under a 2px `colors.ink` rule, both laid
 * straight on the table. Every colour involved is constant across the two
 * themes on purpose (`packages/tokens/src/colors.ts`), so on the walnut dark
 * table the words measured 1.12:1 and the rule with them: the heading was
 * simply gone, and had been for as long as dark mode had existed.
 *
 * So this file does not assert "a heading is rendered". It renders the
 * screen under BOTH themes and reads back the colour each heading is
 * actually printed on — which is the only form of this test that could have
 * failed before the fix. `test/ui/TableHeading.test.tsx` does the same for
 * the component; this one is here so the screen cannot quietly go back to
 * putting words on the table without one.
 */
import * as React from "react";
import { act, render } from "@testing-library/react-native";
import { contrastRatio } from "@keepsake/tokens/contrast";
import { colorsLight } from "@keepsake/tokens/colors";
import type { OwnerListing } from "@keepsake/contracts/listing";
import { LISTING_GROUP_LABELS } from "@/features/mine/groupListings";
import { getMyListings } from "@/api/me";
import { getOwnerToken } from "@/lib/ownerToken";
import { ThemeProvider } from "@/ui/theme";
import { ToastProvider } from "@/ui/Toast";
import Mine from "../../../app/mine/index";

// Same shape as the sibling `[id].test.tsx`: the router and the API are the
// two things this screen reaches for on mount, and neither exists here.
jest.mock("expo-router", () => {
  const ReactActual = jest.requireActual("react");
  return {
    useLocalSearchParams: () => ({}),
    useRouter: () => ({ replace: jest.fn(), push: jest.fn(), setParams: jest.fn() }),
    Link: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
      asChild ? children : ReactActual.createElement(ReactActual.Fragment, null, children),
  };
});

jest.mock("@/api/me", () => ({ getMyListings: jest.fn() }));
jest.mock("@/lib/ownerToken", () => ({ getOwnerToken: jest.fn() }));

const AA = 4.5;

type Node = { type: string; props: Record<string, unknown>; children: (Node | string)[] | null };

function styleOf(node: Node): Record<string, string> {
  return (node.props.style ?? {}) as Record<string, string>;
}

/** react-native-web resolves tokens to `rgba(r,g,b,a)`; `contrastRatio()`
 * speaks `#RRGGBB`. A translucent ground is rejected rather than composited:
 * contrast off a guessed blend would be a number nobody could check. */
function hexOf(color: string): string {
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(color);
  if (m === null) throw new Error(`not an rgba() colour: ${color}`);
  if (Number(m[4]) !== 1) throw new Error(`${color} is translucent`);
  return `#${[m[1], m[2], m[3]].map((c) => Number(c).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** Every node in the tree, each with the ancestors it hangs from (nearest
 * first) — enough to answer "what is this heading actually printed on?".
 * `toJSON()` hands back an array when the tree has more than one root, which
 * it does here: `ToastProvider` renders the toast alongside the screen. */
function walk(node: Node | Node[] | string | null, ancestors: Node[] = []): { node: Node; ancestors: Node[] }[] {
  if (node === null || typeof node === "string") return [];
  if (Array.isArray(node)) return node.flatMap((child) => walk(child, ancestors));
  const chain = [node, ...ancestors];
  return [{ node, ancestors }, ...(node.children ?? []).flatMap((child) => walk(child, chain))];
}

function listing(id: string, title: string, status: OwnerListing["status"]): OwnerListing {
  return {
    id,
    title,
    story: "It sat on my grandmother's shelf for thirty years and should sit on someone else's now.",
    category: "home_kitchen",
    category_chosen_at: null,
    place_name: "Somerville",
    admin1: "MA",
    country: "US",
    photos: [],
    aspects: [],
    published_at: 0,
    status,
    postal_code: "02144",
    moderation_reason: null,
    request_count: 0,
    chosen_request_id: null,
    version: 1,
    created_at: 0,
    updated_at: 0,
    held: false,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

async function renderMine(mode: "light" | "dark") {
  const view = render(
    <ThemeProvider mode={mode}>
      <ToastProvider>
        <Mine />
      </ToastProvider>
    </ThemeProvider>,
  );
  await act(async () => {
    await flush();
  });
  return view;
}

describe("Mine", () => {
  beforeEach(() => {
    jest.mocked(getOwnerToken).mockReset().mockReturnValue("ks_test");
    jest
      .mocked(getMyListings)
      .mockReset()
      .mockResolvedValue([listing("listing-1", "A hand-thrown mug", "approved"), listing("listing-2", "Brass compass", "pending")]);
  });

  it("heads each non-empty group and renders nothing for the empty ones", async () => {
    const { toJSON } = await renderMine("light");
    const json = JSON.stringify(toJSON());

    // Raw-tree assertions for the same reason `test/ui/Button.test.tsx`
    // gives: the library's text queries don't match RNW's output here.
    expect(json).toContain(LISTING_GROUP_LABELS.live);
    expect(json).toContain(LISTING_GROUP_LABELS.reviewing);
    expect(json).toContain("A hand-thrown mug");
    // No listing is withdrawn, so that group is absent entirely rather than
    // heading an empty stretch of table.
    expect(json).not.toContain(LISTING_GROUP_LABELS.withdrawn);
  });

  it.each(["light", "dark"] as const)("prints every group heading on paper, legibly, in %s mode", async (mode) => {
    const { toJSON } = await renderMine(mode);
    const labels: string[] = Object.values(LISTING_GROUP_LABELS);

    // `Eyebrow` marks its words `accessibilityRole="header"`, which RNW
    // turns into a real `role="heading"` element.
    const headings = walk(toJSON() as unknown as Node | Node[]).filter(
      ({ node }) => node.props.role === "heading" && (node.children ?? []).some((c) => labels.includes(c as string)),
    );
    expect(headings).toHaveLength(2);

    for (const { node, ancestors } of headings) {
      const paper = ancestors.find((a) => typeof styleOf(a).backgroundColor === "string");
      if (paper === undefined) throw new Error(`"${String(node.children?.[0])}" is printed on the table, not on paper`);

      const ground = hexOf(styleOf(paper).backgroundColor ?? "");
      expect(contrastRatio(hexOf(styleOf(node).color ?? ""), ground)).toBeGreaterThanOrEqual(AA);
      // And the paper is the constant chrome tint, so the ratio above is the
      // same number under either lamp — the point of #216's fix.
      expect(ground).toBe(colorsLight.surface.toUpperCase());
    }
  });
});

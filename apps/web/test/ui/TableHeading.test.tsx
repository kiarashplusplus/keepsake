/**
 * Issue #216. `TableHeading` exists for exactly one reason — a section
 * heading on the tabletop has to stay legible when the tabletop turns to
 * walnut — so this asserts that property directly, off the colours the
 * component actually renders, rather than asserting the words are present
 * and calling it covered.
 *
 * The check that could not fail, if it were written the obvious way: render
 * once in light mode and eyeball the markup. The bug this replaces was
 * invisible in light mode and had been for the whole life of the screen. So
 * both modes are rendered here, the strip's own fill and the ink on it are
 * read back out of the tree, and `contrastRatio()` — the same helper
 * `packages/tokens/test/contrast.test.ts` uses — is run over the pair.
 * Revert the component to a bare `Eyebrow` and the dark case drops to
 * 1.12:1 and this fails.
 */
import * as React from "react";
import { render } from "@testing-library/react-native";
import { contrastRatio } from "@keepsake/tokens/contrast";
import { colorsLight } from "@keepsake/tokens/colors";
import { ThemeProvider } from "@/ui/theme";
import { TableHeading } from "@/ui/TableHeading";

/** WCAG AA for body-sized text, the bar `packages/tokens` holds itself to. */
const AA = 4.5;

type Node = { type: string; props: Record<string, unknown>; children: (Node | string)[] | null };

/** react-native-web resolves every token to `rgba(r,g,b,a)` before it reaches
 * the tree, and `contrastRatio()` speaks `#RRGGBB` only. Alpha is asserted
 * to be 1 rather than composited away: a translucent heading over a table
 * whose colour flips would be the same bug wearing a different hat. */
function hexOf(color: string): string {
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(color);
  if (m === null) throw new Error(`not an rgba() colour: ${color}`);
  if (Number(m[4]) !== 1) throw new Error(`${color} is translucent; contrast off a composited colour is a guess`);
  return `#${[m[1], m[2], m[3]].map((c) => Number(c).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function flatten(node: Node | string | null): Node[] {
  if (node === null || typeof node === "string") return [];
  return [node, ...(node.children ?? []).flatMap(flatten)];
}

function styleOf(node: Node): Record<string, string> {
  return (node.props.style ?? {}) as Record<string, string>;
}

function renderHeading(mode: "light" | "dark") {
  const { toJSON } = render(
    <ThemeProvider mode={mode}>
      <TableHeading note="3 pieces on the table">Live</TableHeading>
    </ThemeProvider>,
  );
  const root = toJSON() as unknown as Node;
  const nodes = flatten(root);
  // `Eyebrow` gives its words `accessibilityRole="header"`, which RNW turns
  // into a real `role="heading"` element — the one node on screen that is
  // the heading, without this test having to guess at DOM order.
  const heading = nodes.find((n) => n.props.role === "heading");
  const note = nodes.find((n) => (n.children ?? []).includes("3 pieces on the table"));
  if (heading === undefined || note === undefined) throw new Error("heading or note missing from the tree");
  return { root, heading, note, json: JSON.stringify(toJSON()) };
}

describe("TableHeading", () => {
  it("prints the heading and its note on one strip", () => {
    const { json } = renderHeading("light");

    // Same reason `test/ui/Button.test.tsx` reads the raw tree: at these
    // pinned versions the library's text queries don't match RNW's
    // react-test-renderer output.
    expect(json).toContain("Live");
    expect(json).toContain("3 pieces on the table");
  });

  it.each(["light", "dark"] as const)("clears AA on %s mode's table, because it is on paper either way", (mode) => {
    const { root, heading, note } = renderHeading(mode);

    const ground = hexOf(styleOf(root).backgroundColor ?? "");

    // The two ratios first, because they are the issue: 14.25:1 and 4.89:1
    // as of the palette this shipped against, asserted as the AA bar rather
    // than the exact figures so a future re-hex of the paper or the ink is
    // free to move them and only a failure is a failure. Point the strip's
    // fill at `colors.bg` and the dark case reports 1.12:1 here.
    expect(contrastRatio(hexOf(styleOf(heading).color ?? ""), ground)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(hexOf(styleOf(note).color ?? ""), ground)).toBeGreaterThanOrEqual(AA);

    // And the fill is the chrome paper, not the table. `surface` is one of
    // the constant tokens, so light and dark assert the same hex — which is
    // the whole argument of #216's fix, stated as a test.
    expect(ground).toBe(colorsLight.surface.toUpperCase());
  });
});

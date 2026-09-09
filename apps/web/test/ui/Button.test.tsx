import * as React from "react";
import { render, fireEvent } from "@testing-library/react-native";
import { contrastRatio } from "@keepsake/tokens/contrast";
import { colorsLight } from "@keepsake/tokens/colors";
import { ThemeProvider } from "@/ui/theme";
import { Button } from "@/ui/Button";
import { AA, compositeOver, hexOf, styleOf, walk, type Node } from "../support/paper";

/** The Pressable's own container style. `UNSAFE_getByProps` elsewhere in
 * this file matches the composite element's authored `accessibilityRole`
 * prop before RNW's host translation; `toJSON()`'s tree is host output,
 * where that prop has already become the DOM `role` attribute. */
function pressableNode(tree: unknown): Node {
  const nodes = walk(tree as never);
  const found = nodes.find(({ node }) => node.props.role === "button" || node.props.role === "link");
  if (found === undefined) throw new Error("no Pressable found in tree");
  return found.node;
}

function pressableBackground(tree: unknown): string {
  return hexOf(styleOf(pressableNode(tree)).backgroundColor);
}

/** The label's own rendered text colour — the first descendant of the
 * Pressable that authors a `color`, which is the `Text` this component
 * renders its label with (there is exactly one, arrow glyph aside, and the
 * arrow shares the same colour). */
function labelColor(tree: unknown): string {
  const button = pressableNode(tree);
  const found = walk(button.children as never).find(({ node }) => typeof styleOf(node).color === "string");
  if (found === undefined) throw new Error("no coloured label found under the Pressable");
  return hexOf(styleOf(found.node).color);
}

/** CSS `opacity` as authored on the Pressable, defaulting to 1 the way an
 * absent style property does when the browser actually paints it. */
function pressableOpacity(tree: unknown): number {
  const raw = styleOf(pressableNode(tree)).opacity;
  return raw === undefined ? 1 : Number(raw);
}

describe("Button", () => {
  it("renders its label and fires onPress", () => {
    const onPress = jest.fn();

    const { toJSON, UNSAFE_getByProps } = render(
      <ThemeProvider mode="light">
        <Button label="Give something" onPress={onPress} />
      </ThemeProvider>,
    );

    // Label assertion via the raw tree, and interaction via
    // `UNSAFE_getByProps` + `fireEvent.press`, rather than `getByText` /
    // `getByRole`: at these pinned versions, @testing-library/react-native's
    // text and role queries don't match react-native-web's react-test-renderer
    // output (confirmed with minimal repros against bare RN `<Text>` and
    // `<Pressable accessibilityRole="button">`, independent of this
    // component — not a bug here). `UNSAFE_getByProps` matches the
    // composite Pressable's own authored props before RNW's host
    // translation, and `fireEvent.press` on it still resolves to invoking
    // `props.onPress` directly.
    expect(JSON.stringify(toJSON())).toContain("Give something");

    const button = UNSAFE_getByProps({ accessibilityRole: "button" });
    fireEvent.press(button);

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  /**
   * Issue #373 finding 6, second half: a disabled primary used to be
   * `colors.accent` at 0.5 opacity — a washed-out pink indistinguishable
   * from `loading`, which was the exact same fill and opacity plus a
   * spinner. `isInert` now separates "nothing to submit yet" from "mid
   * submit": only the former swaps the fill to `colors.pencil`. This fails
   * the moment someone goes back to keying the fill off `disabled ||
   * loading` the way the bug did.
   */
  it("an inert (disabled, not loading) primary button fills with pencil, not a faded accent", () => {
    const { toJSON } = render(
      <ThemeProvider mode="light">
        <Button label="Continue" disabled />
      </ThemeProvider>,
    );

    expect(pressableBackground(toJSON())).toBe(colorsLight.pencil.toUpperCase());
  });

  it("a loading primary button keeps the full stamp-red fill — busy is not the same as inert", () => {
    const { toJSON } = render(
      <ThemeProvider mode="light">
        <Button label="Continue" loading />
      </ThemeProvider>,
    );

    const bg = pressableBackground(toJSON());
    expect(bg).toBe(colorsLight.accent.toUpperCase());
    expect(bg).not.toBe(colorsLight.pencil.toUpperCase());
  });

  it("an enabled primary button fills with the stamp red, distinct from both other states", () => {
    const { toJSON } = render(
      <ThemeProvider mode="light">
        <Button label="Continue" onPress={jest.fn()} />
      </ThemeProvider>,
    );

    expect(pressableBackground(toJSON())).toBe(colorsLight.accent.toUpperCase());
  });

  /**
   * PR #378 review, on the first cut of this fix: it asserted
   * `contrastRatio(onAccent, pencil)` — the two source *tokens* — while
   * `Button` still applied the old `disabled` opacity (0.65) on top of the
   * new `pencil` fill. CSS `opacity` blends the whole element against
   * whatever card is behind it, so the actual rendered label-on-fill
   * contrast was 2.17:1 (measured against a `surface` card) — finding 6's
   * washed-out, barely-legible block, now grey instead of pink — and a test
   * comparing the two tokens directly could not see that, because it never
   * asked what opacity the component was actually painting with.
   *
   * This composites the fill and the label the same way a browser would —
   * `compositeOver(token, renderedOpacity, card)` — off the values actually
   * read back from the rendered tree, not assumed, so a regression that
   * reintroduces a faded inert state (whatever opacity it picks) fails this
   * exact test rather than a differently-shaped one that never asks.
   */
  it("the inert button's fill and label are legible as ACTUALLY RENDERED — composited opacity, not just the source tokens", () => {
    const { toJSON } = render(
      <ThemeProvider mode="light">
        <Button label="Continue" disabled />
      </ThemeProvider>,
    );
    const tree = toJSON();
    const opacity = pressableOpacity(tree);

    // The card a primary CTA sits on in the product (a `Card`/`StepShell`
    // cut from `surface`) — see `Button.tsx`'s own secondary-variant
    // comment, which reads contrast against this same ground.
    const card = colorsLight.surface;
    const renderedFill = compositeOver(pressableBackground(tree), opacity, card);
    const renderedLabel = compositeOver(labelColor(tree), opacity, card);

    expect(contrastRatio(renderedLabel, renderedFill)).toBeGreaterThanOrEqual(AA);
    expect(contrastRatio(renderedFill, card)).toBeGreaterThanOrEqual(3);
  });
});

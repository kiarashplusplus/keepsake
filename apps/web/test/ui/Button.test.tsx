import * as React from "react";
import { render, fireEvent } from "@testing-library/react-native";
import { contrastRatio } from "@keepsake/tokens/contrast";
import { colorsLight } from "@keepsake/tokens/colors";
import { ThemeProvider } from "@/ui/theme";
import { Button } from "@/ui/Button";
import { hexOf, styleOf, walk } from "../support/paper";

/** The Pressable's own container style. `UNSAFE_getByProps` elsewhere in
 * this file matches the composite element's authored `accessibilityRole`
 * prop before RNW's host translation; `toJSON()`'s tree is host output,
 * where that prop has already become the DOM `role` attribute. */
function pressableBackground(tree: unknown): string {
  const nodes = walk(tree as never);
  const found = nodes.find(({ node }) => node.props.role === "button" || node.props.role === "link");
  if (found === undefined) throw new Error("no Pressable found in tree");
  return hexOf(styleOf(found.node).backgroundColor);
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

  it("the inert fill still reads on the card it sits on (AA-ish, not decorative-only contrast)", () => {
    // `pencil` is already asserted against `print`/`surface` at >=4.5:1 in
    // `packages/tokens/test/contrast.test.ts`'s "objects on the table read
    // on both papers" block (it is a `TEXT_ON_GROUND_TOKENS` member); this
    // just confirms the label colour Button actually paints (`onAccent`)
    // reads against that same fill once it's the button's own background,
    // not merely against paper.
    expect(contrastRatio(colorsLight.onAccent, colorsLight.pencil)).toBeGreaterThanOrEqual(3);
  });
});

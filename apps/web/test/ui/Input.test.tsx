/**
 * Issue #373 finding 6: `focus` and `dangerText` used to be the same literal
 * (`#7A2515`), so `docs/qa/baseline/ux-mobile/item-request-sheet-filled.jpg`'s
 * focused-but-valid date field drew the exact same maroon rule as
 * `give-2-story-short.jpg`'s invalid story field. `packages/tokens/test/
 * contrast.test.ts` guards the token itself; this guards that `Input` (and
 * `FieldFrame`'s shared `useFieldControlLook`, which `DateField`/`TextArea`
 * also spend) actually wires focus and error to two different tokens rather
 * than one hard-coded colour that happens to match today.
 */
import * as React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import { colorsLight } from "@keepsake/tokens/colors";
import { ThemeProvider } from "@/ui/theme";
import { Input } from "@/ui/Input";
import { hexOf, styleOf, walk } from "../support/paper";

function inputNode(tree: unknown) {
  const nodes = walk(tree as never);
  const found = nodes.find(({ node }) => node.type === "input" || node.props["data-testid"] === "input" || node.props.accessibilityLabel === "Story");
  if (found === undefined) throw new Error("no field control found in tree");
  return found.node;
}

describe("Input focus/error baseline colour", () => {
  it("is ink at rest, brass/gold on focus, and red on error — three distinct colours", () => {
    const { getByLabelText, toJSON } = render(
      <ThemeProvider mode="light">
        <Input label="Story" value="" onChangeText={jest.fn()} />
      </ThemeProvider>,
    );

    const restBorder = hexOf(styleOf(inputNode(toJSON())).borderBottomColor);
    expect(restBorder).toBe(colorsLight.ink.toUpperCase());

    act(() => {
      fireEvent(getByLabelText("Story"), "focus", { target: { value: "" }, nativeEvent: {} });
    });
    const focusedBorder = hexOf(styleOf(inputNode(toJSON())).borderBottomColor);
    expect(focusedBorder).toBe(colorsLight.focus.toUpperCase());

    // The guard that matters: focus must not be the error colour, and vice
    // versa — this is the exact bug (both were `#7A2515`).
    expect(focusedBorder).not.toBe(colorsLight.dangerText.toUpperCase());
    expect(focusedBorder).not.toBe(colorsLight.danger.toUpperCase());
  });

  it("takes over with the danger colour when there is an error, even while focused", () => {
    const { getByLabelText, toJSON } = render(
      <ThemeProvider mode="light">
        <Input label="Story" value="" onChangeText={jest.fn()} error="Tell us a little more." />
      </ThemeProvider>,
    );

    act(() => {
      fireEvent(getByLabelText("Story"), "focus", { target: { value: "" }, nativeEvent: {} });
    });
    const errorBorder = hexOf(styleOf(inputNode(toJSON())).borderBottomColor);
    expect(errorBorder).toBe(colorsLight.danger.toUpperCase());
    expect(errorBorder).not.toBe(colorsLight.focus.toUpperCase());
  });
});

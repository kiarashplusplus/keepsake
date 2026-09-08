import * as React from "react";
import { render } from "@testing-library/react-native";
import { colorsDark, colorsLight } from "@keepsake/tokens/colors";
import { contrastRatio, hexToRgb } from "@keepsake/tokens/contrast";
import { type } from "@keepsake/tokens/typography";
import { ThemeProvider } from "@/ui/theme";
import { SafetyNote } from "@/ui/SafetyNote";

const COPY = "Meet somewhere public and well-lit.";

/**
 * Issue #224 item 2. The bug was not that this copy was missing — it was that
 * it was set in `caption`/`textTertiary`, the product's small print. So the
 * assertions below are about the SETTING, and each one fails if the component
 * drifts back:
 *
 *  - a serif face at body size, not 12px CourierPrime;
 *  - `inkSoft`, not the palette's faintest text token;
 *  - and the contrast of that choice against the sheet's own fill, asserted
 *    from the tokens rather than from a number copied into a comment, so the
 *    claim in `SafetyNote.tsx`'s header cannot quietly go stale.
 */
/** react-native-web serialises colours as `rgba(r,g,b,1.00)` and lengths as
 * `"16px"`, so the token has to be put through the same transform to be
 * looked for in the tree. Derived from the token, never typed out, so a
 * palette edit moves the assertion with it. */
function rgba(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},1.00)`;
}

function px(value: number): string {
  return `"${value}px"`;
}

function tree(mode: "light" | "dark"): string {
  return JSON.stringify(
    render(
      <ThemeProvider mode={mode}>
        <SafetyNote>{COPY}</SafetyNote>
      </ThemeProvider>,
    ).toJSON(),
  );
}

describe("SafetyNote", () => {
  it("renders its copy unchanged", () => {
    expect(tree("light")).toContain(COPY);
  });

  it("is set in the serif body face, not the 12px mono caption", () => {
    const rendered = tree("light");

    expect(rendered).toContain(`"fontFamily":"${type.body.fontFamily}"`);
    expect(rendered).toContain(`"fontSize":${px(type.body.fontSize)}`);
    // The exact pair #224 objected to.
    expect(rendered).not.toContain(`"fontFamily":"${type.caption.fontFamily}"`);
    expect(rendered).not.toContain(`"fontSize":${px(type.caption.fontSize)}`);
    expect(rendered).not.toContain(rgba(colorsLight.textTertiary));
  });

  it("uses inkSoft in both themes, because the note is an object on the table", () => {
    // `inkSoft` is one of the constant tokens, so the note reads identically
    // under the walnut table as under the kraft one — the reason this
    // component draws a rule instead of filling a `Sunken` well, whose
    // `tableEdge` fill does flip. Asserting both modes is what stops that
    // reasoning from being a comment nobody checks.
    expect(colorsDark.inkSoft).toBe(colorsLight.inkSoft);
    for (const mode of ["light", "dark"] as const) {
      expect(tree(mode)).toContain(rgba(colorsLight.inkSoft));
    }
  });

  it("clears AA against the sheet fill by a wide margin, and beats what it replaced", () => {
    // `ui/Sheet.tsx` paints `colors.surface`; both operands are constant
    // across themes, so this one number is the whole story.
    const chosen = contrastRatio(colorsLight.inkSoft, colorsLight.surface);
    const replaced = contrastRatio(colorsLight.textTertiary, colorsLight.surface);

    expect(chosen).toBeGreaterThan(replaced);
    // Both operands clear AA (4.5) on their own now — the Linen & Rust
    // refresh (#256) lightened `inkSoft` and darkened `textTertiary`, which
    // is what moved these from 10.0/4.9 — so the assertion that carries
    // #224's argument is the *gap*, not the floor: the note is set a clear
    // step stronger than the small print it was rescued from.
    expect(chosen / replaced).toBeGreaterThan(1.4);
    // The numbers quoted in `SafetyNote.tsx`'s header comment.
    expect(chosen).toBeCloseTo(9.2, 1);
    expect(replaced).toBeCloseTo(6.2, 1);
  });
});

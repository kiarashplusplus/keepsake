import * as React from "react";
import { Text, View } from "react-native";
import { render } from "@testing-library/react-native";
import { colorsDark, colorsLight, colorsWeb, TABLE_TOKENS } from "@keepsake/tokens/colors";
import { ThemeProvider, useColors, useThemeMode } from "@/ui/theme";

function Probe(): React.ReactElement {
  const colors = useColors();
  const { mode } = useThemeMode();
  return <Text>{`${colors.bg}|${colors.ink}|${mode}`}</Text>;
}

/**
 * Asserted against the raw render tree rather than `getByText`/`getByTestId`:
 * at these pinned versions, @testing-library/react-native's text/testID
 * queries don't match react-native-web's react-test-renderer output even for
 * a bare `<Text>` (confirmed with a minimal repro outside this file — not a
 * bug in our components). `toJSON()` reflects exactly what was rendered.
 */
function renderedJson(ui: React.ReactElement): string {
  return JSON.stringify(render(ui).toJSON());
}

describe("ThemeProvider on the web", () => {
  it("renders its children on the first render, with no storage read", () => {
    // The regression this file exists for. The provider used to return
    // `null` until an async `localStorage` read resolved, and `expo export`
    // static-renders every route with no effects and no storage — so every
    // exported page shipped an empty <body> and nothing was visible until
    // the JS bundle hydrated. A synchronous first render IS the fix; if this
    // test ever fails, the exported HTML is empty again.
    const json = renderedJson(
      <ThemeProvider>
        <Text>a keepsake</Text>
      </ThemeProvider>,
    );
    expect(json).toContain("a keepsake");
  });

  it("resolves the mode but paints the table from CSS variables in either one", () => {
    // What "dark" means on the web is `data-theme="dark"` on <html>, set by
    // the pre-hydration script before the first paint — NOT a different
    // colour in the markup. The tree renders `var(--ks-bg)` either way,
    // which is what makes the static HTML valid for both themes and leaves
    // hydration nothing to disagree about.
    const dark = renderedJson(
      <ThemeProvider mode="dark">
        <Probe />
      </ThemeProvider>,
    );
    const light = renderedJson(
      <ThemeProvider mode="light">
        <Probe />
      </ThemeProvider>,
    );

    // The literal is the light value, read from the palette rather than
    // typed here: a palette refresh (#256 moved the table from kraft to
    // linen) must not be able to fail this test, which is about the shape of
    // the value and not its colour.
    expect(dark).toContain(`var(--ks-bg, ${colorsLight.bg})`);
    expect(dark).toContain("|dark");
    expect(light).toContain("|light");
    // The only difference between the two renders is the resolved mode the
    // probe prints — every colour in them is byte-identical.
    expect(dark.replace("|dark", "|X")).toBe(light.replace("|light", "|X"));
    // And no literal table colour from either palette leaked into the markup.
    expect(dark).not.toContain(colorsDark.tableEdge);
    expect(light).not.toContain(`"${colorsLight.bg}"`);
  });

  it("keeps every non-table token a literal, so only the table needs CSS", () => {
    // `colorsWeb` is only safe because the palette barely flips: the eight
    // TABLE_TOKENS differ between light and dark and nothing else does. If a
    // ninth token starts flipping, it has to become a variable too — and
    // this fails until it does.
    for (const [key, value] of Object.entries(colorsWeb)) {
      const flips = (TABLE_TOKENS as readonly string[]).includes(key);
      expect(value.startsWith("var(--ks-")).toBe(flips);
      if (!flips) expect(value).toBe(colorsLight[key as keyof typeof colorsLight]);
    }
  });

  it("still gives components a usable colour when there is no provider above them", () => {
    const json = renderedJson(
      <View>
        <Probe />
      </View>,
    );
    expect(json).toContain(`var(--ks-bg, ${colorsLight.bg})`);
  });
});

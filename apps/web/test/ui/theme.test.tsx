import * as React from "react";
import { Text } from "react-native";
import { render } from "@testing-library/react-native";
import { colorsDark, colorsLight } from "@keepsake/tokens/colors";
import { ThemeProvider, useColors } from "@/ui/theme";

function Probe(): React.ReactElement {
  const colors = useColors();
  return <Text>{colors.bg}</Text>;
}

describe("ThemeProvider", () => {
  it("resolves an explicit dark mode to colorsDark", () => {
    const { toJSON } = render(
      <ThemeProvider mode="dark">
        <Probe />
      </ThemeProvider>,
    );

    // Asserted against the raw render tree rather than `getByText`/
    // `getByTestId`: at these pinned versions, @testing-library/react-native's
    // text/testID queries don't match react-native-web's react-test-renderer
    // output even for a bare `<Text>` (confirmed with a minimal repro outside
    // this file — not a bug in our components). `toJSON()` reflects exactly
    // what was rendered, which is what this test actually needs to check:
    // that `useColors()` resolved to `colorsDark`, not `colorsLight`.
    const rendered = JSON.stringify(toJSON());
    expect(rendered).toContain(colorsDark.bg);
    expect(rendered).not.toContain(colorsLight.bg);
  });
});

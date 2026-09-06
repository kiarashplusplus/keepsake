import * as React from "react";
import { render, fireEvent } from "@testing-library/react-native";
import { ThemeProvider } from "@/ui/theme";
import { Button } from "@/ui/Button";

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
});

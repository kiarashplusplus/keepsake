import * as React from "react";
import { render } from "@testing-library/react-native";
import { ThemeProvider } from "@/ui/theme";
import { Turnstile } from "@/ui/Turnstile";

describe("Turnstile (jest-expo/web resolves the .web.tsx implementation)", () => {
  it("calls onToken('') immediately when no site key is configured, so the flow still works on preview", () => {
    const onToken = jest.fn();

    render(
      <ThemeProvider mode="light">
        <Turnstile onToken={onToken} />
      </ThemeProvider>,
    );

    expect(onToken).toHaveBeenCalledWith("");
    expect(onToken).toHaveBeenCalledTimes(1);
  });
});

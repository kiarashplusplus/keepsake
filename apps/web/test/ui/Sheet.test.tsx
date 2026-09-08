import * as React from "react";
import { render } from "@testing-library/react-native";
import { ThemeProvider } from "@/ui/theme";
import { Sheet } from "@/ui/Sheet";
import { Text } from "@/ui/Text";

jest.mock("react-dom", () => ({
  ...jest.requireActual("react-dom"),
  // react-test-renderer cannot traverse a DOM portal. Keep its children in
  // this renderer so the test can inspect the exact styles sent to the web.
  createPortal: (children: React.ReactNode) => children,
}));

describe("Sheet", () => {
  beforeEach(() => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
  });

  afterEach(() => {
    document.getElementById("root")?.remove();
  });

  it("lays out against 100dvh without a fixed or visualViewport correction", () => {
    const rendered = JSON.stringify(
      render(
        <ThemeProvider mode="light">
          <Sheet visible onClose={jest.fn()} title="A sheet">
            <Text>Body</Text>
          </Sheet>
        </ThemeProvider>,
      ).toJSON(),
    );

    // WebKit #297779 can leave visualViewport.height/offsetTop corrupt after
    // the keyboard closes. This assertion protects the durable workaround:
    // the route-anchored overlay and its panel are sized by CSS's dynamic
    // viewport, with no fixed positioning or JS transform chasing that data.
    expect(rendered).toContain('"position":"absolute"');
    expect(rendered).toContain('"height":"100dvh"');
    expect(rendered).toContain('"maxHeight":"calc(100dvh - 64px)"');
    expect(rendered).not.toContain('"position":"fixed"');
    expect(rendered).not.toContain('"transform"');
  });

  it("does not render anything while closed", () => {
    expect(
      render(
        <ThemeProvider mode="light">
          <Sheet visible={false} onClose={jest.fn()}>
            <Text>Body</Text>
          </Sheet>
        </ThemeProvider>,
      ).toJSON(),
    ).toBeNull();
  });
});

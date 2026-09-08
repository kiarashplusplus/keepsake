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
    const tree = render(
      <ThemeProvider mode="light">
        <Sheet visible onClose={jest.fn()} title="A sheet">
          <Text>Body</Text>
        </Sheet>
      </ThemeProvider>,
    ).toJSON();

    // The overlay is the root here: the `createPortal` mock above keeps the
    // portal's children in this renderer rather than sending them to a DOM
    // node react-test-renderer cannot traverse.
    const overlay = Array.isArray(tree) ? tree[0] : tree;
    if (overlay == null) throw new Error("the sheet rendered nothing while visible");
    const overlayStyle = Object.assign({}, ...[overlay.props.style].flat(Infinity).filter(Boolean));

    // WebKit #297779 can leave visualViewport.height/offsetTop corrupt after
    // the keyboard closes, so the durable workaround is to read neither. The
    // overlay is sized by CSS's dynamic viewport and pinned by `absolute`
    // against the initial containing block (`body` never scrolls) — no
    // `fixed` to be captured by a transformed ancestor, and no JS transform
    // chasing viewport metrics. Asserted against the overlay's own style
    // rather than the serialized tree, so an unrelated `transform` on some
    // descendant cannot quietly pass or fail this.
    expect(overlayStyle).toMatchObject({ position: "absolute", height: "100dvh" });
    expect(overlayStyle.transform).toBeUndefined();

    // The panel's bound comes from the same dynamic viewport, not from a
    // measured pixel height that would need re-measuring as the keyboard moves.
    expect(JSON.stringify(tree)).toContain('"maxHeight":"calc(100dvh - 64px)"');
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

import * as React from "react";
import { render } from "@testing-library/react-native";
import type { ReactTestRendererJSON } from "react-test-renderer";
import { ThemeProvider } from "@/ui/theme";
import { Sheet } from "@/ui/Sheet";
import { Text } from "@/ui/Text";

jest.mock("react-dom", () => ({
  ...jest.requireActual("react-dom"),
  // react-test-renderer cannot traverse a DOM portal. Keep its children in
  // this renderer so the test can inspect the exact styles sent to the web.
  createPortal: (children: React.ReactNode) => children,
}));

type Json = ReactTestRendererJSON | string | null;

// Walks the plain (non-composite) `toJSON()` tree rather than a
// react-test-renderer query: `ScrollView` on web is several nested
// composites deep (RN's own wrapper around react-native-web's
// implementation), and `@testing-library/react-native`'s `within()` scoped
// to the outer one doesn't reliably see through that nesting to the host
// text underneath it. The rendered DOM shape has no such ambiguity, and it's
// the thing a fix like this actually has to get right.
function findByTestId(node: Json | Json[], testId: string): ReactTestRendererJSON | null {
  if (node == null) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByTestId(child, testId);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof node === "string") return null;
  // React Native Web renders `testID` to the DOM as `data-testid`, not as a
  // `testID` attribute — the JSON tree here is host output, not props.
  if (node.props?.["data-testid"] === testId) return node;
  return findByTestId(node.children, testId);
}

function containsText(node: Json | Json[], text: string): boolean {
  if (node == null) return false;
  if (Array.isArray(node)) return node.some((child) => containsText(child, text));
  if (typeof node === "string") return node === text;
  return containsText(node.children, text);
}

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

  // Issue #373 finding 1: the request sheet's SEND button lived inside the
  // scrolling body, so a 7-line safety paragraph above it was enough to push
  // it under the fold at 390px — cut in half empty, off-screen once the note
  // held a few lines (see the baseline frames this fixed). `footer` is the
  // fix's mechanism: content passed there has to render outside the
  // `ScrollView` (`testID="sheet-scroll-body"`) so it stays on screen
  // regardless of how far the body scrolls. Checked against the rendered DOM
  // shape, not a whole-tree string match — a substring match can't tell
  // "outside the ScrollView" from "inside it", and both would contain the text.
  it("renders the footer outside the ScrollView, not as part of the scrolling body", () => {
    const tree = render(
      <ThemeProvider mode="light">
        <Sheet visible onClose={jest.fn()} title="A sheet" footer={<Text>Send</Text>}>
          <Text>Body</Text>
        </Sheet>
      </ThemeProvider>,
    ).toJSON();

    const scrollBody = findByTestId(tree, "sheet-scroll-body");
    if (scrollBody === null) throw new Error("expected to find the sheet's ScrollView by testID");
    expect(containsText(scrollBody, "Body")).toBe(true);
    expect(containsText(scrollBody, "Send")).toBe(false);
    expect(containsText(tree, "Send")).toBe(true);
  });

  // A sheet that never passes `footer` — `ReportSheet`, `ReasonSheet`,
  // `HandoffSheet` — must keep rendering exactly as it did before this prop
  // existed: no extra wrapper, no stray top rule with nothing under it.
  it("renders no footer wrapper when footer is omitted", () => {
    const instance = render(
      <ThemeProvider mode="light">
        <Sheet visible onClose={jest.fn()} title="A sheet">
          <Text>Body</Text>
        </Sheet>
      </ThemeProvider>,
    );

    expect(JSON.stringify(instance.toJSON())).not.toContain("borderTopWidth");
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

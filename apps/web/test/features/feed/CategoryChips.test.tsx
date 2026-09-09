import * as React from "react";
import { ScrollView, StyleSheet } from "react-native";
import { fireEvent, render } from "@testing-library/react-native";
import { CategoryChips } from "@/features/feed/CategoryChips";

const PHONE_WIDTH = 390;
const DESKTOP_WIDTH = 1280;

/** Same trick, and the same reason, as `test/app/index.test.tsx`: jsdom lays
 * nothing out and reports `documentElement.clientWidth` as 0, so
 * react-native-web's `Dimensions` — and therefore `useWindowDimensions()` —
 * has to be told the viewport width and nudged with a `resize` event. */
function setViewportWidth(width: number): void {
  Object.defineProperty(window.document.documentElement, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(window.document.documentElement, "clientHeight", { configurable: true, value: 844 });
  window.dispatchEvent(new Event("resize"));
}

/** A scroll event shaped like react-native's, so the component's own
 * end-detection arithmetic is what is under test. */
function scrollEvent(offsetX: number, viewportWidth: number, contentWidth: number): { nativeEvent: object } {
  return {
    nativeEvent: {
      contentOffset: { x: offsetX, y: 0 },
      layoutMeasurement: { width: viewportWidth, height: 40 },
      contentSize: { width: contentWidth, height: 40 },
    },
  };
}

describe("CategoryChips overflow affordance (issue #219, strengthened for #373 finding 4)", () => {
  it("fades the trailing edge while the row still scrolls, and hides the fade at the end", () => {
    setViewportWidth(PHONE_WIDTH);
    const { UNSAFE_getByType, UNSAFE_queryByProps } = render(<CategoryChips value={null} onChange={jest.fn()} />);

    // Before any measurement arrives the fade is shown: an unmeasured row is
    // far more likely to be an overflowing one, and the failure this fixes is
    // a cut-off chip with no affordance at all.
    const fade = UNSAFE_queryByProps({ testID: "category-overflow-fade" });
    expect(fade).not.toBeNull();
    // It sits over the last chip, so it must not swallow that chip's tap, and
    // it is decoration a screen reader has no use for.
    expect(fade?.props.pointerEvents).toBe("none");
    expect(fade?.props.accessibilityElementsHidden).toBe(true);
    expect(fade?.props.importantForAccessibility).toBe("no-hide-descendants");

    // #373 finding 4: the baseline frames (`ux-mobile/feed.jpg` and friends)
    // show this exact fade rendered by #349's two-stop, 32px version, and it
    // still reads as a hard cut — a plain 0%→100% ramp stays under ~20%
    // opacity for most of its width. The fix is a wider band with a
    // front-loaded middle stop, so a pixel well short of the trailing edge is
    // already visibly dissolving rather than still reading as full-strength
    // text. Asserting the gradient string (not just its presence) is what
    // makes this test fail again if someone reverts to the two-stop version
    // while leaving the `testID` and pointer/a11y props untouched.
    const fadeStyle = StyleSheet.flatten(fade?.props.style);
    expect(fadeStyle.width).toBe(48); // space.xxxl, up from space.xxl's 32
    expect(fadeStyle.backgroundImage).toContain("60%");
    expect(fadeStyle.backgroundImage).toMatch(/^linear-gradient\(to right, .+00 0%, .+ 60%, .+ 100%\)$/);

    // The chevron is the "arrow" half of the fix: a glyph that says "more"
    // in words a fade alone cannot, sitting inside the same decorative,
    // pointer-transparent, AT-hidden node as the fade so it carries the same
    // guarantees rather than needing its own.
    expect(fade?.props.children).toBeTruthy();
    // ...and it sits at the opaque end of the band rather than its middle:
    // centred, it printed over the trailing chip's letters in the baseline
    // frame taken right after #380 landed. `flex-end` is what keeps the
    // glyph on clean paper.
    expect(fadeStyle.alignItems).toBe("flex-end");

    const scroller = UNSAFE_getByType(ScrollView);
    fireEvent.scroll(scroller, scrollEvent(0, 350, 900));
    expect(UNSAFE_queryByProps({ testID: "category-overflow-fade" })).not.toBeNull();

    // Scrolled to the end: there is nothing left to hint at.
    fireEvent.scroll(scroller, scrollEvent(550, 350, 900));
    expect(UNSAFE_queryByProps({ testID: "category-overflow-fade" })).toBeNull();

    // ...and back again.
    fireEvent.scroll(scroller, scrollEvent(120, 350, 900));
    expect(UNSAFE_queryByProps({ testID: "category-overflow-fade" })).not.toBeNull();
  });

  it("shows no fade when the chips fit without scrolling", () => {
    setViewportWidth(PHONE_WIDTH);
    const { UNSAFE_getByType, UNSAFE_queryByProps } = render(<CategoryChips value={null} onChange={jest.fn()} />);

    fireEvent.scroll(UNSAFE_getByType(ScrollView), scrollEvent(0, 900, 900));

    expect(UNSAFE_queryByProps({ testID: "category-overflow-fade" })).toBeNull();
  });

  /**
   * The row used to be two component trees picked by `useWindowDimensions()`
   * — a `ScrollView` on a phone, a wrapping `View` on a desktop — so the one
   * static export baked the phone's scroller into the HTML every desktop got
   * (`packages/tokens/src/breakpoints.ts`). It is one `ScrollView` at both
   * widths now, and CSS decides whether its content wraps; where it wraps
   * there is nothing to scroll, which is what the wrapping row always was.
   *
   * jsdom resolves no media queries, so this asserts the switch is wired, not
   * what it resolves to. `e2e/browse.spec.ts` runs in both projects and is
   * where the resolved behaviour is checked.
   */
  it("hands the wrap/scroll decision to CSS rather than to the measured width", () => {
    setViewportWidth(DESKTOP_WIDTH);
    const { UNSAFE_getByType, UNSAFE_getByProps } = render(<CategoryChips value={null} onChange={jest.fn()} />);

    const scroller = UNSAFE_getByType(ScrollView);
    expect(StyleSheet.flatten(scroller.props.contentContainerStyle)).toMatchObject({ flexWrap: "var(--ks-chips-wrap, nowrap)" });
    // And the fade carries the switch that takes it off screen once the row
    // wraps — a gradient over an edge that no longer overflows.
    expect(StyleSheet.flatten(UNSAFE_getByProps({ testID: "category-overflow-fade" }).props.style)).toMatchObject({
      display: "var(--ks-chips-fade, flex)",
    });
  });
});

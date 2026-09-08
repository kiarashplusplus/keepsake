import * as React from "react";
import { ScrollView } from "react-native";
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

describe("CategoryChips overflow affordance (issue #219)", () => {
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

  it("wraps instead of scrolling at desktop width, so there is no edge to fade", () => {
    setViewportWidth(DESKTOP_WIDTH);
    const { UNSAFE_queryByType, UNSAFE_queryByProps } = render(<CategoryChips value={null} onChange={jest.fn()} />);

    expect(UNSAFE_queryByType(ScrollView)).toBeNull();
    expect(UNSAFE_queryByProps({ testID: "category-overflow-fade" })).toBeNull();
  });
});

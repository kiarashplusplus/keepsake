import * as React from "react";
import { ScrollView, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type ViewStyle } from "react-native";
import { CATEGORIES, CATEGORY_LABELS, type Category } from "@keepsake/contracts/listing";
import { space } from "@keepsake/tokens/spacing";
import { useColors } from "@/ui/theme";
import { useViewport } from "@/ui/viewport";
import { Chip } from "@/ui/Chip";

export type CategoryChipsProps = {
  value: Category | null;
  onChange: (category: Category | null) => void;
};

/** How much of the trailing chip the fade covers. Wide enough to read as a
 * deliberate soft edge rather than a rendering artefact, narrow enough that
 * the cut-off chip is still legible underneath it. */
const FADE_WIDTH = space.xxl;

/** A scroll position within this many px of the end counts as the end —
 * fractional layout on the web means `offset + viewport` almost never lands
 * exactly on `contentSize`. */
const END_SLACK_PX = 1;

/**
 * One row, at both widths. It used to be two component trees chosen by
 * `useWindowDimensions()` — a horizontal `ScrollView` on a phone, a wrapping
 * `View` on a desktop — which meant the static export baked the phone's
 * scroller into the HTML every desktop got, fade and all, until hydration
 * replaced it. Now the scroller is always the markup and CSS decides whether
 * its content wraps (`--ks-chips-wrap`), which at a desktop width leaves
 * nothing to scroll and so renders exactly as the wrapping row did. See
 * `packages/tokens/src/breakpoints.ts`.
 */
export function CategoryChips({ value, onChange }: CategoryChipsProps): React.ReactElement {
  const colors = useColors();
  const vp = useViewport();

  // Issue #219: at 390px the row is cut mid-word ("Jewelry & w…") at the
  // right edge with nothing to say it scrolls — it reads as a layout bug,
  // not as an affordance. The three measurements are refs, not state,
  // because only the boolean derived from them should ever cause a render:
  // a scroll handler that `setState`s the raw offset re-renders thirteen
  // chips on every frame of a flick.
  const viewportWidth = React.useRef(0);
  const contentWidth = React.useRef(0);
  const offsetX = React.useRef(0);
  // Starts true: until the first layout and content-size measurement arrive
  // (and on any platform or test environment that never delivers them), a
  // visible fade is the safe default — the failure mode we are fixing is
  // the row having no affordance at all.
  const [moreToEnd, setMoreToEnd] = React.useState(true);

  function recompute(): void {
    const measured = viewportWidth.current > 0 && contentWidth.current > 0;
    setMoreToEnd(!measured || offsetX.current + viewportWidth.current < contentWidth.current - END_SLACK_PX);
  }

  function handleLayout(event: LayoutChangeEvent): void {
    viewportWidth.current = event.nativeEvent.layout.width;
    recompute();
  }

  function handleContentSizeChange(contentWidthPx: number): void {
    contentWidth.current = contentWidthPx;
    recompute();
  }

  function handleScroll(event: NativeSyntheticEvent<NativeScrollEvent>): void {
    offsetX.current = event.nativeEvent.contentOffset.x;
    viewportWidth.current = event.nativeEvent.layoutMeasurement.width;
    contentWidth.current = event.nativeEvent.contentSize.width;
    recompute();
  }

  const chips = (
    <>
      <Chip label="All" selected={value === null} onPress={() => onChange(null)} />
      {CATEGORIES.map((category) => (
        <Chip
          key={category}
          label={CATEGORY_LABELS[category]}
          selected={value === category}
          onPress={() => onChange(value === category ? null : category)}
        />
      ))}
    </>
  );

  // The fade is painted in `colors.surface` because the chips sit inside a
  // `Card`, which fills exactly that — the row appears to dissolve into its
  // own paper. `${colors.surface}00` is the same token with a zero alpha
  // channel rather than the keyword `transparent`: `transparent` is
  // transparent *black* in CSS, and interpolating kraft toward it leaves a
  // visible grey bruise across the middle of the gradient in every browser.
  // Nothing new enters the palette either way.
  //
  // `linear-gradient` is a CSS value with no React Native style equivalent,
  // so it goes through the same `as ViewStyle` escape hatch the codebase
  // already uses for `boxShadow` (`Button.tsx`, `Surface.tsx`) and
  // `backgroundImage` (`KraftTable.web.tsx`).
  //
  // `vp.chipsFade` is what takes it off screen once the row wraps: past the
  // breakpoint there is no overflow, so an edge fade would be a gradient
  // over nothing.
  const fade: ViewStyle = {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    width: FADE_WIDTH,
    ...({ backgroundImage: `linear-gradient(to right, ${colors.surface}00, ${colors.surface})` } as ViewStyle),
    ...vp.chipsFade,
  };

  return (
    <View style={{ position: "relative" }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        onLayout={handleLayout}
        onContentSizeChange={handleContentSizeChange}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        // `paddingEnd` so the last chip doesn't sit flush against the card's
        // edge when scrolled to the end. `flexWrap` is the whole width
        // switch: `nowrap` and this scrolls, `wrap` and it is the wrapping
        // row a desktop always had, with nothing left to scroll.
        // `flexShrink` has to step with `flexWrap`: react-native-web gives
        // every View `flex-shrink: 0`, and this container is a flex item of a
        // row-direction scroller, so at 0 it is sized to its unwrapped content
        // and `wrap` never gets a narrower box to wrap into — the desktop row
        // scrolled sideways with the fade hidden. At 1 it shrinks to the
        // scroller's width and wraps; it stays 0 while scrolling so
        // `onContentSizeChange` still measures the full row and the fade still
        // knows there is more.
        contentContainerStyle={{ flexDirection: "row", flexWrap: vp.chipsWrap, flexShrink: vp.chipsShrink, gap: space.sm, paddingEnd: space.sm }}
      >
        {chips}
      </ScrollView>
      {moreToEnd ? (
        // Purely decorative, and it must never eat a tap meant for the chip
        // underneath it: `pointerEvents="none"` for the pointer half, hidden
        // from assistive technology for the other (the chips are all still
        // reachable in the accessibility tree whether or not they are
        // scrolled into view).
        <View
          testID="category-overflow-fade"
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={fade}
        />
      ) : null}
    </View>
  );
}

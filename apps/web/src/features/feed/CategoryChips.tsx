import * as React from "react";
import { ScrollView, View, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, type ViewStyle } from "react-native";
import { CATEGORIES, CATEGORY_LABELS, type Category } from "@keepsake/contracts/listing";
import { space } from "@keepsake/tokens/spacing";
import { useColors } from "@/ui/theme";
import { useViewport } from "@/ui/viewport";
import { Chip } from "@/ui/Chip";
import { Text } from "@/ui/Text";

export type CategoryChipsProps = {
  value: Category | null;
  onChange: (category: Category | null) => void;
};

/**
 * How much of the trailing chip the fade covers. Issue #373 finding 4: the
 * original `space.xxl` (32px) fade was mathematically present but
 * perceptually invisible — a plain 0%→100% linear ramp over 32px of an
 * 11px label stays under ~20% opacity for most of its width, which reads as
 * ordinary anti-aliasing, not an affordance, at both screenshot and phone
 * scale. Widened to `space.xxxl` (48px) and paired with the front-loaded
 * gradient stops below and an explicit chevron so the row reads as
 * "scrolls" even to someone skimming, not just to someone who measures it.
 */
const FADE_WIDTH = space.xxxl;

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
  // Three stops, not two: a plain 0%→100% linear ramp spends its first half
  // barely above 0% opacity (measured — a pixel 40% of the way across a
  // two-stop version of this gradient blends to within a few percent of its
  // unfaded colour), which is indistinguishable from ordinary text
  // antialiasing at phone scale. `60%` opacity by the midpoint front-loads
  // the visible dissolve into the first half of the band, so the affordance
  // reads at a glance instead of only surviving a pixel-level measurement
  // (issue #373 finding 4 — the two-stop version shipped in #349 was already
  // present in every baseline frame and still read as a hard cut).
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
    // The chevron sits at the *opaque* end of the band, not its middle. The
    // first capture after #380 (docs/qa/baseline/ux-mobile/feed.jpg) showed
    // why: centred, the glyph landed 24px in, where the gradient is only
    // ~60% surface, so it printed on top of the trailing chip's own letters
    // — "JEWELRY›&" — which reads as a rendering fault, the exact thing this
    // affordance exists to stop the row looking like. At `flex-end` it sits
    // over the 100% stop, on clean paper, with the chip dissolving behind it.
    alignItems: "flex-end",
    justifyContent: "center",
    paddingRight: space.xs,
    ...({ backgroundImage: `linear-gradient(to right, ${colors.surface}00 0%, ${colors.surface}99 60%, ${colors.surface} 100%)` } as ViewStyle),
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
        >
          {/* The chevron is the "arrow" half of issue #373 finding 4's fix,
           * alongside the fade above: a gradient alone still reads as a
           * rendering artefact to someone skimming rather than measuring
           * pixel values, so this spells out "more" in the same glyph
           * `app/index.tsx`'s "Have something to give away? →" already uses
           * for the same idea elsewhere on this screen. `textSecondary` (the
           * pencil-grey token) rather than `ink` keeps it a hint, not a
           * fourteenth chip. */}
          <Text
            variant="label"
            color="textSecondary"
            style={{ fontSize: 14 }}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {"›"}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

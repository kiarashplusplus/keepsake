import * as React from "react";
import { View, type ViewStyle } from "react-native";
import { useColors } from "@/ui/theme";

/**
 * Fixed full-bleed backdrop: the table itself. A seamless, isotropic
 * fibre-noise texture (`public/kraft-grain.svg` — feTurbulence run through
 * a low-contrast alpha matrix, tiled at 480x480 with `stitchTiles="stitch"`
 * so no seam is visible even at 1920px) sits over the flipping `table`
 * token, plus a soft vignette toward the edges — stronger in dark mode,
 * where it also carries the lamp's warm pool of light near the top of the
 * page. The vignette is a plain CSS radial gradient on the base layer, not
 * part of the tiled texture, so it never repeats. The noise tile is its own
 * layer so its opacity can be tuned independently per theme (lower in dark,
 * so it reads as a quieter fleck on walnut rather than a loud overlay).
 * Replaces the v2 `PaperGrain` overlay: where that was a multiply-blended
 * grain over a flat colour, this owns the colour itself (it IS the page
 * background, not a layer above it), so `app/_layout.tsx` and the Stack's
 * `contentStyle` stay transparent and let it show through everywhere.
 * Web-only: native gets the no-op stub.
 */
export function KraftTable(): React.ReactElement {
  const colors = useColors();

  const base: ViewStyle = {
    position: "fixed",
    inset: 0,
    zIndex: -1,
    backgroundColor: colors.table,
    backgroundImage: [
      `radial-gradient(ellipse 900px 480px at 50% -60px, ${colors.lampLight}, transparent 70%)`,
      // Soft vignette: darkens toward the edges by ~6%, drawn as a CSS
      // gradient (not the tile) so it scales with the viewport and never
      // repeats at any width.
      "radial-gradient(ellipse 1400px 900px at 50% 45%, transparent 55%, rgba(40,35,31,0.06) 100%)",
    ].join(", "),
    backgroundRepeat: "no-repeat, no-repeat",
  } as unknown as ViewStyle;

  const noise: ViewStyle = {
    position: "absolute",
    inset: 0,
    backgroundImage: "url(/kraft-grain.svg)",
    backgroundRepeat: "repeat",
    backgroundSize: "480px 480px",
    // `var(--ks-grain-*)`, not `mode === "light" ? … : …`, for the same
    // reason the colours are custom properties (see
    // `@keepsake/tokens/colors`' `colorsWeb`): this component is rendered
    // into the static HTML at export time, where the theme is not knowable,
    // and a value that differs between that render and the visitor's first
    // client render is a hydration mismatch on the element that covers the
    // whole page. The two pairs of values live in `app/+html.tsx`'s
    // THEME_CSS — including #256's "linen needs only a trace of fibre: half
    // the former light-mode grain", which is what the light opacity there
    // says.
    backgroundBlendMode: "var(--ks-grain-blend, multiply)",
    opacity: "var(--ks-grain-opacity, 0.5)",
  } as unknown as ViewStyle;

  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={base}>
      <View pointerEvents="none" style={noise} />
    </View>
  );
}

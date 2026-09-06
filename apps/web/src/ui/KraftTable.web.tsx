import * as React from "react";
import { View, type ViewStyle } from "react-native";
import { useColors, useThemeMode } from "@/ui/theme";

/**
 * Fixed full-bleed backdrop: the table itself. A directional fibre-noise
 * texture (`public/kraft-grain.svg`, feTurbulence, ~8% opacity) over the
 * flipping `bg`/`tableEdge` tokens, plus a soft vignette toward the edges —
 * stronger in dark mode, where it also carries the lamp's warm pool of
 * light near the top of the page. Replaces the v2 `PaperGrain` overlay:
 * where that was a multiply-blended grain over a flat colour, this owns the
 * colour itself (it IS the page background, not a layer above it), so
 * `app/_layout.tsx` and the Stack's `contentStyle` stay transparent and let
 * it show through everywhere. Web-only: native gets the no-op stub.
 */
export function KraftTable(): React.ReactElement {
  const { mode } = useThemeMode();
  const colors = useColors();

  const base: ViewStyle = {
    position: "fixed",
    inset: 0,
    zIndex: -1,
    backgroundColor: colors.bg,
    backgroundImage: [
      `radial-gradient(ellipse 900px 480px at 50% -60px, ${colors.lampLight}, transparent 70%)`,
      `radial-gradient(ellipse 1400px 900px at 50% 40%, transparent 55%, ${colors.tableEdge} 130%)`,
      "url(/kraft-grain.svg)",
    ].join(", "),
    backgroundRepeat: "no-repeat, no-repeat, repeat",
    backgroundBlendMode: mode === "light" ? "normal, normal, multiply" : "normal, normal, overlay",
    opacity: 1,
  } as unknown as ViewStyle;

  return <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={base} />;
}

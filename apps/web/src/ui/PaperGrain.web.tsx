import * as React from "react";
import { View, type ViewStyle } from "react-native";
import { useThemeMode } from "@/ui/theme";

/**
 * Fixed full-screen tiling grain texture (`public/grain.svg`, feTurbulence),
 * matched to the marketing site's `body::before`: 0.06 multiply on cream,
 * 0.09 normal on the dark ground, and above everything (z 9999) so it also
 * sits on sheets and toasts — it is the paper, not a layer under it.
 * Web-only: `.web.tsx` beats the platformless `PaperGrain.tsx` stub in
 * Metro's module resolution on web, so native builds get the no-op instead
 * of a DOM-only `backgroundImage`/`mixBlendMode`/`position:fixed` style,
 * none of which exist on RN's `ViewStyle` type — built as a plain object and
 * cast once rather than fighting excess-property checks property by
 * property.
 */
export function PaperGrain(): React.ReactElement {
  const { mode } = useThemeMode();

  const webOnlyStyle = {
    position: "fixed",
    inset: 0,
    backgroundImage: "url(/grain.svg)",
    backgroundRepeat: "repeat",
    mixBlendMode: mode === "light" ? "multiply" : "normal",
    opacity: mode === "light" ? 0.06 : 0.09,
    zIndex: 9999,
  } as unknown as ViewStyle;

  return <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={webOnlyStyle} />;
}

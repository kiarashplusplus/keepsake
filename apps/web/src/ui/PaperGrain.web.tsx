import * as React from "react";
import { View, type ViewStyle } from "react-native";
import { useThemeMode } from "@/ui/theme";

/**
 * Fixed full-screen tiling grain texture (`public/grain.svg`, feTurbulence).
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
    opacity: mode === "light" ? 0.045 : 0.07,
    zIndex: 0,
  } as unknown as ViewStyle;

  return <View pointerEvents="none" style={webOnlyStyle} />;
}

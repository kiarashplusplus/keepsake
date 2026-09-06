import * as React from "react";
import { View, type ViewStyle } from "react-native";

const HEIGHT = 10;

/**
 * The section-divider: a hand-drawn pencil underline (`public/pencil-underline.svg`,
 * a wavy stroke, tiled edge-to-edge), replacing the v2 torn-paper deckle
 * strip. `ink` is constant (see colors.ts's file header) so the stroke can
 * be a single static asset rather than a per-theme variant. `backgroundImage`
 * tiling is DOM-only, hence the `.web.tsx` split.
 */
export function PencilRule({ style }: { style?: ViewStyle }): React.ReactElement {
  const webOnly = {
    height: HEIGHT,
    width: "100%",
    backgroundImage: "url(/pencil-underline.svg)",
    backgroundRepeat: "repeat-x",
    backgroundSize: "120px 10px",
  } as unknown as ViewStyle;

  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[webOnly, style]} />;
}

import * as React from "react";
import { View, type ViewStyle } from "react-native";
import { useColors } from "@/ui/theme";

/** Native stub: a plain ink hairline until the native flip. The hand-drawn
 * pencil stroke lives in `PencilRule.web.tsx` (tiled `background-image`,
 * which has no RN equivalent). */
export function PencilRule({ style }: { style?: ViewStyle }): React.ReactElement {
  const colors = useColors();
  return <View accessibilityElementsHidden style={[{ height: 1, width: "100%", backgroundColor: colors.ink, opacity: 0.5 }, style]} />;
}

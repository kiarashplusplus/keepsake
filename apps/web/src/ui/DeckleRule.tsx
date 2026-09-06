import * as React from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { useColors } from "@/ui/theme";

/** Native stub: a plain hairline until the native flip. The torn-paper edge
 * lives in `DeckleRule.web.tsx` (CSS `clip-path`, which has no RN equivalent). */
export function DeckleRule({ style }: { style?: ViewStyle }): React.ReactElement {
  const colors = useColors();
  return <View accessibilityElementsHidden style={[{ height: StyleSheet.hairlineWidth, width: "100%", backgroundColor: colors.rule }, style]} />;
}

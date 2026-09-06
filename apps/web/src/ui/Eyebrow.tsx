import * as React from "react";
import { View, type ViewStyle } from "react-native";
import { space } from "@keepsake/tokens/spacing";
import { useColors } from "@/ui/theme";
import { Text, type TextColor } from "@/ui/Text";

export type EyebrowProps = {
  children: React.ReactNode;
  /** A short hairline before the words, for the one eyebrow that opens a page. */
  tick?: boolean;
  color?: TextColor;
  align?: "start" | "center";
  style?: ViewStyle;
};

/** Spaced small-caps Fraunces in the bottle-green second voice: the section
 * head that sits above every display heading (replaces Inter all-caps
 * `label` wherever a label reads as a heading). */
export function Eyebrow({ children, tick = false, color = "accent2Text", align = "start", style }: EyebrowProps): React.ReactElement {
  const colors = useColors();
  return (
    <View
      style={[
        { flexDirection: "row", alignItems: "center", gap: space.sm, justifyContent: align === "center" ? "center" : "flex-start" },
        style,
      ]}
    >
      {tick ? <View accessibilityElementsHidden style={{ width: 22, height: 1, backgroundColor: colors.accent2Text }} /> : null}
      <Text variant="eyebrow" color={color} accessibilityRole="header">
        {children}
      </Text>
    </View>
  );
}

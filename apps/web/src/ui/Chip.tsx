import * as React from "react";
import { Pressable, type ViewStyle } from "react-native";
import { radii } from "@keepsake/tokens/radii";
import { space } from "@keepsake/tokens/spacing";
import { useColors } from "@/ui/theme";
import { Text } from "@/ui/Text";

export type ChipProps = {
  label: string;
  selected?: boolean;
  onPress?: () => void;
};

export function Chip({ label, selected = false, onPress }: ChipProps): React.ReactElement {
  const colors = useColors();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }): ViewStyle => ({
        paddingVertical: space.xs,
        paddingHorizontal: space.md,
        borderRadius: radii.pill,
        borderWidth: 1,
        borderColor: selected ? "transparent" : colors.rule,
        backgroundColor: selected ? colors.accentSoft : colors.surface,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Text variant="bodySm" color={selected ? "accentText" : "textSecondary"} style={{ fontWeight: "500" }}>
        {label}
      </Text>
    </Pressable>
  );
}

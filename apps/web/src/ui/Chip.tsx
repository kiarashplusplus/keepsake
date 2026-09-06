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

/** A small pencil-outlined label, not a pill: a typewritten word boxed in
 * ink, filled with the tape-red wash when selected. Opaque `surface` fill
 * always, so the label is safe to read regardless of what it's sitting
 * over. */
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
        borderRadius: radii.sm,
        borderWidth: selected ? 2 : 1,
        borderColor: colors.ink,
        backgroundColor: selected ? colors.accentSoft : colors.surface,
        opacity: pressed ? 0.75 : 1,
      })}
    >
      <Text variant="label" color={selected ? "accentText" : "ink"} style={{ fontSize: 11 }}>
        {label}
      </Text>
    </Pressable>
  );
}

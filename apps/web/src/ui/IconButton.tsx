import * as React from "react";
import { Pressable, type PressableStateCallbackType, type ViewStyle } from "react-native";
import { Icon, type IconName } from "@/ui/Icon";
import { radii } from "@keepsake/tokens/radii";
import { useColors } from "@/ui/theme";

export type IconButtonProps = {
  icon: IconName;
  label: string;
  onPress?: () => void;
  size?: number;
  disabled?: boolean;
  style?: ViewStyle;
};

const MIN_SIZE = 44;

/** A round icon-only tap target, always at least 44x44 with a required
 * accessibility label since there's no visible text to fall back on. */
export function IconButton({ icon, label, onPress, size = 20, disabled = false, style }: IconButtonProps): React.ReactElement {
  const colors = useColors();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }: PressableStateCallbackType): ViewStyle[] => [
        {
          width: MIN_SIZE,
          height: MIN_SIZE,
          borderRadius: radii.pill,
          alignItems: "center",
          justifyContent: "center",
          opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
        },
        style ?? {},
      ]}
    >
      <Icon name={icon} size={size} color={colors.ink} />
    </Pressable>
  );
}

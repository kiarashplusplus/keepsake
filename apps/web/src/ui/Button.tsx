import * as React from "react";
import { ActivityIndicator, Pressable, type PressableStateCallbackType, type ViewStyle } from "react-native";
import { radii } from "@keepsake/tokens/radii";
import { space } from "@keepsake/tokens/spacing";
import { useColors } from "@/ui/theme";
import { Text, type TextColor } from "@/ui/Text";

export type ButtonVariant = "primary" | "secondary" | "ghost";

export type ButtonProps = {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
};

const MIN_HEIGHT = 44;

export function Button({ label, onPress, variant = "primary", loading = false, disabled = false, style }: ButtonProps): React.ReactElement {
  const colors = useColors();
  const isDisabled = disabled || loading;

  const variantStyle = (pressed: boolean, hovered: boolean): { container: ViewStyle; textColor: TextColor } => {
    const dim = pressed || hovered ? 0.9 : 1;
    if (variant === "primary") {
      return {
        container: { backgroundColor: colors.accent, opacity: isDisabled ? 0.5 : dim, borderWidth: 0 },
        textColor: "onAccent",
      };
    }
    if (variant === "secondary") {
      return {
        container: {
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.border,
          opacity: isDisabled ? 0.5 : dim,
        },
        textColor: "ink",
      };
    }
    return {
      container: { backgroundColor: "transparent", borderWidth: 0, opacity: isDisabled ? 0.5 : dim },
      textColor: "accentText",
    };
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={onPress}
      // react-native-web exposes hover state via PressableStateCallbackType's
      // internal hover tracking is not part of RN's public type, so we treat
      // hover the same as pressed for the dim, and only check `pressed` here.
      style={({ pressed }: PressableStateCallbackType) => {
        const { container } = variantStyle(pressed, false);
        return [
          {
            minHeight: MIN_HEIGHT,
            paddingHorizontal: space.lg,
            borderRadius: radii.pill,
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "row",
            gap: space.sm,
          } as ViewStyle,
          container,
          style,
        ];
      }}
    >
      {loading ? <ActivityIndicator color={variant === "primary" ? colors.onAccent : colors.accentText} /> : null}
      <Text variant="title" color={variantStyle(false, false).textColor}>
        {label}
      </Text>
    </Pressable>
  );
}

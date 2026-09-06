import * as React from "react";
import { ActivityIndicator, Pressable, type PressableStateCallbackType, type TextStyle, type ViewStyle } from "react-native";
import { radii, shadow } from "@keepsake/tokens/radii";
import { space } from "@keepsake/tokens/spacing";
import { useColors } from "@/ui/theme";
import { useMotion } from "@/ui/MotionProvider";
import { Text, type TextColor } from "@/ui/Text";

/**
 * primary   — the ONE pill: terracotta fill, paper-on-paper shadow.
 * secondary — a bordered, square-ish button for an action row that has no
 *             single hero (Edit / Withdraw next to each other).
 * link      — the site's underlined text-with-arrow treatment, for the second
 *             action that sits next to a primary ("Skip", "See it").
 * ghost     — bare text, for destructive/quiet actions.
 */
export type ButtonVariant = "primary" | "secondary" | "link" | "ghost";

export type ButtonProps = {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
  /** `link` only: the trailing arrow (on by default). */
  arrow?: boolean;
  style?: ViewStyle;
};

// react-native-web's Pressable passes `hovered` (and `focused`) alongside
// `pressed`; RN's public type only declares `pressed`. Read it through a
// widened type rather than pretending hover doesn't exist on the web.
type WebPressableState = PressableStateCallbackType & { hovered?: boolean };

const MIN_HEIGHT = 44;

const TEXT_COLOR: Record<ButtonVariant, TextColor> = {
  primary: "onAccent",
  secondary: "ink",
  link: "accent2Text",
  ghost: "accentText",
};

export function Button({ label, onPress, variant = "primary", loading = false, disabled = false, arrow, style }: ButtonProps): React.ReactElement {
  const colors = useColors();
  const motion = useMotion();
  const isDisabled = disabled || loading;
  const showArrow = variant === "link" && arrow !== false;

  const containerFor = (pressed: boolean, hovered: boolean): ViewStyle => {
    const lifted = hovered && !isDisabled;
    const opacity = isDisabled ? 0.5 : pressed ? 0.85 : 1;
    switch (variant) {
      case "primary":
        return {
          backgroundColor: colors.accent,
          paddingHorizontal: space.xl,
          borderRadius: radii.pill,
          opacity,
          // `boxShadow` renders on iOS/Android/web alike under the New Architecture.
          ...({ boxShadow: lifted ? shadow.cardHover(colors.shadowStrong) : shadow.card(colors.shadow) } as ViewStyle),
        };
      case "secondary":
        return {
          backgroundColor: lifted ? colors.surface : "transparent",
          paddingHorizontal: space.lg,
          borderRadius: radii.md,
          borderWidth: 1,
          borderColor: colors.rule,
          opacity,
        };
      case "link":
        return {
          backgroundColor: "transparent",
          paddingHorizontal: 0,
          borderRadius: 0,
          borderBottomWidth: 1,
          borderBottomColor: lifted ? colors.accent2Text : colors.rule,
          opacity,
        };
      case "ghost":
        return { backgroundColor: "transparent", paddingHorizontal: space.lg, borderRadius: radii.md, opacity };
    }
  };

  const labelStyle: TextStyle = { fontWeight: "600" };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={onPress}
      style={(state) => {
        const { pressed, hovered = false } = state as WebPressableState;
        return [
          {
            minHeight: MIN_HEIGHT,
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "row",
            gap: space.sm,
            // Web-only transition so the hover shadow/underline eases instead of snapping.
            ...({ transitionProperty: "box-shadow, border-color, background-color", transitionDuration: `${motion.liftMs}ms` } as ViewStyle),
          } as ViewStyle,
          containerFor(pressed, hovered),
          style,
        ];
      }}
    >
      {loading ? <ActivityIndicator color={variant === "primary" ? colors.onAccent : colors.accent2Text} /> : null}
      <Text variant="body" color={TEXT_COLOR[variant]} style={labelStyle}>
        {label}
      </Text>
      {showArrow ? (
        <Text variant="body" color={TEXT_COLOR[variant]} style={labelStyle} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          →
        </Text>
      ) : null}
    </Pressable>
  );
}

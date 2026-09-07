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
  /** Most callers (category filters, reason pickers) are plain buttons —
   * the default. `app/admin.tsx`'s status filter row is the one place a
   * `Chip` sits directly inside a `role="tablist"` container, and ARIA
   * requires a tablist's own children to carry `role="tab"` (axe's
   * `aria-required-children`, flagged once `/admin` got its own scan in
   * `e2e/a11y.spec.ts`) — this is that escape hatch, not a general-purpose
   * variant. */
  role?: "button" | "tab";
};

/** A small pencil-outlined label, not a pill: a typewritten word boxed in
 * ink, filled with the tape-red wash when selected. Opaque `surface` fill
 * always, so the label is safe to read regardless of what it's sitting
 * over. */
export function Chip({ label, selected = false, onPress, role = "button" }: ChipProps): React.ReactElement {
  const colors = useColors();
  // `aria-selected` is only an allowed attribute on a handful of roles
  // ("tab", "option", ...) — axe's `aria-allowed-attr` correctly flags it on
  // a plain button. `aria-pressed` is the button-role equivalent for "this
  // toggle is on", so the state is still conveyed either way.
  const ariaState = role === "tab" ? { "aria-selected": selected } : { "aria-pressed": selected };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      // react-native-web (0.21) doesn't wire `accessibilityState` through to
      // any of these for a plain `View`/`Pressable`, and a `role` other than
      // what `accessibilityRole` would produce (`"tab"`, for `app/admin.tsx`'s
      // status filter row) has no dedicated RN prop at all — so both are
      // passed as raw attributes (cast through `object`, same technique
      // `QueueItemCard.tsx`'s checkbox and `role="group"` use elsewhere).
      {...({ role, ...ariaState } as object)}
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

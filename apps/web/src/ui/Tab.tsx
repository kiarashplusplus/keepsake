import * as React from "react";
import { Pressable, type ViewStyle } from "react-native";
import type { ColorTokens } from "@keepsake/tokens/colors";
import { space } from "@keepsake/tokens/spacing";
import { useColors } from "@/ui/theme";
import { Text } from "@/ui/Text";

/**
 * The one underline in the product that means "you are here": a 2px
 * stamp-red rule under the current item and a transparent one under the
 * rest, so a row of these never shifts as the selection moves. `AppHeader`'s
 * nav links draw the active route with it, and `/admin`'s section switch
 * draws the current panel with it — the same treatment because they are the
 * same idea, a place you can be, as opposed to a `Chip`, which is a filter
 * you can toggle (#361).
 */
export function tabUnderlineStyle(active: boolean, colors: ColorTokens): ViewStyle {
  return {
    minHeight: 44,
    justifyContent: "center",
    borderBottomWidth: 2,
    borderBottomColor: active ? colors.accent : "transparent",
  };
}

export type TabProps = {
  label: string;
  selected: boolean;
  onPress: () => void;
};

/**
 * One tab in a `role="tablist"` row: an underlined typewritten label, no
 * box, no fill. Deliberately not a `Chip`. `/admin` stacked its section
 * switch directly over the queue's status filter, both rows of identical
 * chips with the identical selected tint, and nothing but each row's
 * `aria-label` said that one changed *which panel* and the other *which
 * queue* (#361). The underline is the difference a sighted moderator gets.
 *
 * ARIA is wired the way `Chip`'s `role="tab"` escape hatch does it:
 * react-native-web does not carry `accessibilityState` through to a
 * `Pressable`, so `role`/`aria-selected` go in as raw attributes.
 */
export function Tab({ label, selected, onPress }: TabProps): React.ReactElement {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      {...({ role: "tab", "aria-selected": selected } as object)}
      onPress={onPress}
      style={({ pressed }): ViewStyle => ({
        ...tabUnderlineStyle(selected, colors),
        paddingHorizontal: space.xs,
        opacity: pressed ? 0.75 : 1,
      })}
    >
      <Text variant="label" color="ink" style={{ fontSize: 12 }}>
        {label}
      </Text>
    </Pressable>
  );
}

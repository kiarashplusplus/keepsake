import * as React from "react";
import { View } from "react-native";
import { space } from "@keepsake/tokens/spacing";
import { useColors } from "@/ui/theme";
import { Text } from "@/ui/Text";

export type StepNumeralsProps = {
  total: number;
  /** Zero-based index of the current step. */
  current: number;
};

/** The give flow's step indicator, typewritten as "01 02 03 04 05": steps
 * done or current in full ink, the current one underlined, the ones ahead
 * faded. Same `progressbar` semantics as the dots it replaced. */
export function StepNumerals({ total, current }: StepNumeralsProps): React.ReactElement {
  const colors = useColors();

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={`Step ${current + 1} of ${total}`}
      accessibilityValue={{ min: 1, max: total, now: current + 1 }}
      style={{ flexDirection: "row", alignItems: "baseline", gap: space.md }}
    >
      {Array.from({ length: total }, (_, index) => index).map((index) => {
        const active = index === current;
        const ahead = index > current;
        return (
          <Text
            key={index}
            variant="label"
            // Steps you have not reached recede by colour, not by opacity:
            // ink at 40% composites to 2.4:1 on the card, which axe flagged.
            // `textTertiary` is a real token, verified at 4.5:1 on both papers.
            color={ahead ? "textTertiary" : "ink"}
            style={{
              fontSize: 12,
              paddingBottom: 2,
              borderBottomWidth: active ? 2 : 0,
              borderBottomColor: colors.accent,
            }}
          >
            {String(index + 1).padStart(2, "0")}
          </Text>
        );
      })}
    </View>
  );
}

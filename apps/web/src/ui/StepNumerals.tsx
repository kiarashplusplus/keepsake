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

/** The give flow's step indicator, set as "01 02 03 04 05" in Fraunces at
 * display optical size: steps done or current in full colour, the current one
 * in ink with a rule under it, the ones ahead in ghosted foil. Same
 * `progressbar` semantics as the dots it replaced. */
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
            variant="eyebrow"
            color={active ? "ink" : "foilText"}
            fontVariationSettings='"opsz" 144, "SOFT" 30, "WONK" 0'
            style={{
              fontSize: 15,
              lineHeight: 20,
              letterSpacing: 1,
              opacity: ahead ? 0.55 : 1,
              paddingBottom: 2,
              borderBottomWidth: active ? 2 : 0,
              borderBottomColor: colors.ink,
            }}
          >
            {String(index + 1).padStart(2, "0")}
          </Text>
        );
      })}
    </View>
  );
}

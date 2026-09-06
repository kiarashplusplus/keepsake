import * as React from "react";
import { View, type ViewStyle } from "react-native";
import { useColors } from "@/ui/theme";

const HEIGHT = 16;

// A strip torn along both edges. Points are percentages of the strip; the top
// edge wanders between 8–40%, the bottom between 60–92%, so the piece reads
// as a ragged slip of paper laid across the page rather than a zigzag.
const TOP_EDGE = "0% 30%, 4% 40%, 9% 12%, 14% 34%, 19% 8%, 24% 36%, 29% 16%, 34% 40%, 39% 12%, 44% 34%, 49% 10%, 54% 38%, 59% 14%, 64% 40%, 69% 10%, 74% 34%, 79% 14%, 84% 38%, 89% 12%, 94% 34%, 100% 18%";
const BOTTOM_EDGE = "100% 82%, 95% 62%, 90% 88%, 85% 66%, 80% 92%, 75% 64%, 70% 86%, 65% 60%, 60% 88%, 55% 66%, 50% 90%, 45% 62%, 40% 84%, 35% 64%, 30% 92%, 25% 66%, 20% 86%, 15% 60%, 10% 88%, 5% 64%, 0% 84%";
const TORN = `polygon(${TOP_EDGE}, ${BOTTOM_EDGE})`;

/**
 * The deckled-edge divider: a torn slip of the sunken paper tone with a 1px
 * `rule` shadow under its lower edge. `clipPath` is DOM-only, hence the
 * `.web.tsx` split — the platformless file renders a hairline.
 */
export function DeckleRule({ style }: { style?: ViewStyle }): React.ReactElement {
  const colors = useColors();
  const torn = (color: string, top: number): ViewStyle =>
    ({ position: "absolute", top, left: 0, right: 0, height: HEIGHT, backgroundColor: color, clipPath: TORN }) as unknown as ViewStyle;

  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[{ height: HEIGHT + 1, width: "100%" }, style]}>
      <View style={torn(colors.rule, 1)} />
      <View style={torn(colors.surfaceSunken, 0)} />
    </View>
  );
}

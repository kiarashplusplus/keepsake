import * as React from "react";
import { View, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withSpring, withTiming } from "react-native-reanimated";
import { useColors } from "@/ui/theme";
import { useMotion } from "@/ui/MotionProvider";
import { Text } from "@/ui/Text";

export type SealState = "breathing" | "settled" | "idle";

const SIZE = 72;

/** The wax-seal signature mark: breathes while a listing is under review,
 * settles with a spring once it goes live. */
export function Seal({ state }: { state: SealState }): React.ReactElement {
  const colors = useColors();
  const motion = useMotion();
  const scale = useSharedValue(state === "settled" ? 0.9 : 1);
  const opacity = useSharedValue(1);

  React.useEffect(() => {
    if (state === "breathing" && !motion.reduce) {
      scale.value = withRepeat(withTiming(1.04, { duration: motion.sealBreathMs / 2 }), -1, true);
      opacity.value = withRepeat(withTiming(0.92, { duration: motion.sealBreathMs / 2 }), -1, true);
      return;
    }
    if (state === "settled") {
      scale.value = withSpring(1, motion.settle);
      opacity.value = withTiming(1, { duration: motion.quickMs });
      return;
    }
    scale.value = 1;
    opacity.value = 1;
  }, [state, motion, scale, opacity]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  const ring: ViewStyle = {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    backgroundColor: colors.accentSoft,
    alignItems: "center",
    justifyContent: "center",
  };

  const disc: ViewStyle = {
    width: SIZE - 12,
    height: SIZE - 12,
    borderRadius: (SIZE - 12) / 2,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  };

  return (
    <Animated.View style={animatedStyle} accessibilityRole="image" accessibilityLabel={`Wax seal, ${state}`}>
      <View style={ring}>
        <View style={disc}>
          <Text variant="displayMd" color="onAccent" style={{ fontStyle: "italic" }}>
            K
          </Text>
        </View>
      </View>
    </Animated.View>
  );
}

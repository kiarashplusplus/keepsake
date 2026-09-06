import * as React from "react";
import { View, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withSpring, withTiming } from "react-native-reanimated";
import { type } from "@keepsake/tokens/typography";
import { useColors } from "@/ui/theme";
import { useMotion } from "@/ui/MotionProvider";
import { Text } from "@/ui/Text";

export type SealState = "breathing" | "settled" | "idle";

const SIZE = 72;
const RING = 2;
const GAP = 3;
const DISC = SIZE - 2 * (RING + GAP);

/** The wax-seal signature mark: a foil ring around a terracotta disc with an
 * italic Fraunces "K" (SOFT/WONK on, same as the wordmark and the OG seal).
 * Breathes while a listing is under review, settles with a spring — a small
 * overshoot and a few degrees of rotation — once it goes live. */
export function Seal({ state }: { state: SealState }): React.ReactElement {
  const colors = useColors();
  const motion = useMotion();
  const scale = useSharedValue(state === "settled" ? 0.86 : 1);
  const rotate = useSharedValue(state === "settled" ? -6 : 0);
  const opacity = useSharedValue(1);

  React.useEffect(() => {
    if (state === "breathing" && !motion.reduce) {
      scale.value = withRepeat(withTiming(1.04, { duration: motion.sealBreathMs / 2 }), -1, true);
      opacity.value = withRepeat(withTiming(0.92, { duration: motion.sealBreathMs / 2 }), -1, true);
      rotate.value = 0;
      return;
    }
    if (state === "settled") {
      scale.value = withSpring(1, motion.settle);
      rotate.value = withSpring(0, motion.settle);
      opacity.value = withTiming(1, { duration: motion.quickMs });
      return;
    }
    scale.value = 1;
    rotate.value = 0;
    opacity.value = 1;
  }, [state, motion, scale, rotate, opacity]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }, { rotate: `${rotate.value}deg` }],
    opacity: opacity.value,
  }));

  const ring: ViewStyle = {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    borderWidth: RING,
    borderColor: colors.foil,
    padding: GAP,
    alignItems: "center",
    justifyContent: "center",
  };

  const disc: ViewStyle = {
    width: DISC,
    height: DISC,
    borderRadius: DISC / 2,
    backgroundColor: colors.accent,
    borderWidth: 1,
    borderColor: colors.accentText,
    alignItems: "center",
    justifyContent: "center",
  };

  return (
    <Animated.View style={animatedStyle} accessibilityRole="image" accessibilityLabel={`Wax seal, ${state}`}>
      <View style={ring}>
        <View style={disc}>
          <Text
            variant="wordmark"
            color="onAccent"
            fontVariationSettings={type.wordmark.fontVariationSettings}
            style={{ fontSize: 30, lineHeight: 34, letterSpacing: 0 }}
          >
            K
          </Text>
        </View>
      </View>
    </Animated.View>
  );
}

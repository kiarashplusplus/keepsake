// The v3 identity's signature mark: a red rubber stamp, pressed slightly off
// true, on a face-down print. Replaces the v2 wax seal. While a listing is
// under review it's shown face-down with a stamp ("ON REVIEW"/"HELD") and a
// slow, restless tilt; once a decision lands it flips face-up with a new
// stamp ("LIVE") — reduce-motion swaps instantly instead of flipping.
import * as React from "react";
import { View, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withSequence, withSpring, withTiming } from "react-native-reanimated";
import { radii, shadow } from "@keepsake/tokens/radii";
import { useColors } from "@/ui/theme";
import { useMotion } from "@/ui/MotionProvider";
import { Text } from "@/ui/Text";

export type StampState = "breathing" | "settled" | "idle";

const SIZE = 96;

/** The stamp mark itself: an ink-red rectangle, rotated, with a faint
 * doubled outline to read as slightly uneven ink rather than a vector shape. */
function StampMark({ label }: { label: string }): React.ReactElement {
  const colors = useColors();
  return (
    <View style={{ alignItems: "center", justifyContent: "center" }}>
      <View
        style={{
          position: "absolute",
          borderWidth: 2,
          borderColor: colors.accent,
          paddingVertical: 6,
          paddingHorizontal: 10,
          transform: [{ rotate: "-6.5deg" }],
          opacity: 0.35,
        }}
      >
        <Text variant="stamp" style={{ color: "transparent", fontSize: 12 }}>
          {label}
        </Text>
      </View>
      <View
        style={{
          borderWidth: 2,
          borderColor: colors.accent,
          paddingVertical: 6,
          paddingHorizontal: 10,
          transform: [{ rotate: "-5deg" }],
        }}
      >
        <Text variant="stamp" color="stampText" style={{ fontSize: 12 }}>
          {label}
        </Text>
      </View>
    </View>
  );
}

/** A face-down print bearing the stamp: the ornament used for the review
 * flow and for every empty/idle/not-found state. */
export function Stamp({ state, label }: { state: StampState; label: string }): React.ReactElement {
  const colors = useColors();
  const motion = useMotion();
  const tilt = useSharedValue(0);
  const flip = useSharedValue(1);

  React.useEffect(() => {
    if (state === "breathing" && !motion.reduce) {
      tilt.value = withRepeat(withTiming(motion.reviewTiltDeg, { duration: motion.reviewTiltMs / 2 }), -1, true);
      return;
    }
    if (state === "settled") {
      tilt.value = withTiming(0, { duration: motion.quickMs });
      if (!motion.reduce) {
        flip.value = withSequence(withTiming(0, { duration: motion.quickMs }), withSpring(1, motion.settle));
      }
      return;
    }
    tilt.value = 0;
  }, [state, motion, tilt, flip]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${tilt.value}deg` }, { scaleX: flip.value }],
  }));

  const card: ViewStyle = {
    width: SIZE,
    height: SIZE,
    borderRadius: radii.print,
    backgroundColor: colors.print,
    alignItems: "center",
    justifyContent: "center",
    ...({ boxShadow: `inset 0px 0px 0px 1px rgba(0,0,0,0.08), ${shadow.card(colors.shadow)}` } as ViewStyle),
  };

  return (
    <Animated.View style={animatedStyle} accessibilityRole="image" accessibilityLabel={`Stamp: ${label}`}>
      <View style={card}>
        <StampMark label={label} />
      </View>
    </Animated.View>
  );
}

/** Kept as an alias of `Stamp`/`StampState` for anything still written
 * against the v2 "seal" name. */
export const Seal = Stamp;
export type SealState = StampState;

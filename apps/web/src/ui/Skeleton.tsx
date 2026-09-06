import * as React from "react";
import { type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { radii } from "@keepsake/tokens/radii";
import { useColors } from "@/ui/theme";
import { useMotion } from "@/ui/MotionProvider";

export type SkeletonProps = {
  width?: number | `${number}%` | undefined;
  height?: number | `${number}%` | undefined;
  style?: ViewStyle;
};

/**
 * A sunken placeholder block with an optional shimmer sweep (disabled under
 * reduce-motion). `height` defaults to 120 only when neither an explicit
 * `height` nor an `aspectRatio` (via `style`) is given — a fixed default
 * height would otherwise fight an aspect-ratio block's own height (e.g. the
 * feed's 4:5 image placeholders).
 */
export function Skeleton({ width = "100%", height, style }: SkeletonProps): React.ReactElement {
  const colors = useColors();
  const motion = useMotion();
  const shimmer = useSharedValue(0.6);

  React.useEffect(() => {
    if (motion.reduce) {
      shimmer.value = 0.8;
      return;
    }
    shimmer.value = withRepeat(withTiming(1, { duration: motion.shimmerMs / 2 }), -1, true);
  }, [motion, shimmer]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: shimmer.value }));

  const hasAspectRatio = !!style && "aspectRatio" in style && style.aspectRatio !== undefined;

  const baseStyle: ViewStyle = {
    width,
    ...(height !== undefined || !hasAspectRatio ? { height: height ?? 120 } : null),
    borderRadius: radii.md,
    backgroundColor: colors.surfaceSunken,
  };

  return <Animated.View style={[baseStyle, animatedStyle, style]} />;
}

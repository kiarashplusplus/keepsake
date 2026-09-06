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
 * A blank print: the same white frame and inset edge as `Print`, empty,
 * with a slow shimmer sweep (disabled under reduce-motion) standing in for
 * the photo that hasn't loaded yet. `height` defaults to 120 only when
 * neither an explicit `height` nor an `aspectRatio` (via `style`) is given.
 */
export function Skeleton({ width = "100%", height, style }: SkeletonProps): React.ReactElement {
  const colors = useColors();
  const motion = useMotion();
  const shimmer = useSharedValue(0.7);

  React.useEffect(() => {
    if (motion.reduce) {
      shimmer.value = 0.85;
      return;
    }
    shimmer.value = withRepeat(withTiming(1, { duration: motion.shimmerMs / 2 }), -1, true);
  }, [motion, shimmer]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: shimmer.value }));

  const hasAspectRatio = !!style && "aspectRatio" in style && style.aspectRatio !== undefined;

  const baseStyle: ViewStyle = {
    width,
    ...(height !== undefined || !hasAspectRatio ? { height: height ?? 120 } : null),
    borderRadius: radii.print,
    backgroundColor: colors.print,
    ...({ boxShadow: "inset 0px 0px 0px 1px rgba(0,0,0,0.08)" } as ViewStyle),
  };

  return <Animated.View style={[baseStyle, animatedStyle, style]} />;
}

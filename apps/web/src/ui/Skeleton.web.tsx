// The web skeleton. Same look as `Skeleton.tsx` — a blank print with a
// slow opacity pulse standing in for the photo that hasn't loaded — drawn
// with CSS instead of Reanimated (`ks-skeleton-pulse`, declared in
// `app/+html.tsx`'s ROOT_CSS) so the loop costs no JS runtime on web.
// `prefers-reduced-motion` is honoured both in the stylesheet (so it holds
// even if `useMotion()` hasn't settled yet) and here, by omitting the data
// attribute entirely and resting at the same static opacity the reanimated
// version used under reduce-motion.
import * as React from "react";
import { View, type ViewStyle } from "react-native";
import { radii } from "@keepsake/tokens/radii";
import { useColors } from "@/ui/theme";
import { useMotion } from "@/ui/MotionProvider";

export type SkeletonProps = {
  width?: number | `${number}%` | undefined;
  height?: number | `${number}%` | undefined;
  style?: ViewStyle;
};

export function Skeleton({ width = "100%", height, style }: SkeletonProps): React.ReactElement {
  const colors = useColors();
  const motion = useMotion();

  const hasAspectRatio = !!style && "aspectRatio" in style && style.aspectRatio !== undefined;

  const baseStyle: ViewStyle = {
    width,
    ...(height !== undefined || !hasAspectRatio ? { height: height ?? 120 } : null),
    borderRadius: radii.print,
    backgroundColor: colors.print,
    opacity: motion.reduce ? 0.85 : 0.7,
    ...({ boxShadow: "inset 0px 0px 0px 1px rgba(0,0,0,0.08)" } as ViewStyle),
  };

  const dataProps = motion.reduce ? null : ({ dataSet: { ksSkeleton: "pulse" } } as object);

  return <View style={[baseStyle, style]} {...dataProps} />;
}

import * as React from "react";
import { View, type ViewProps, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { radii, shadow } from "@keepsake/tokens/radii";
import { useColors } from "@/ui/theme";
import { useMotion } from "@/ui/MotionProvider";

export type TagCardProps = Omit<ViewProps, "style"> & {
  /** Lifts 2px and tilts `tagTiltDeg` on hover — picked up like a tag. Off
   * under reduce-motion (`useMotion()` folds it to zero). */
  interactive?: boolean;
  /** Which way the tag leans on hover; alternate across a grid so the row
   * doesn't all lean the same way. */
  tilt?: 1 | -1;
  /** The punched hole + knotted string at the square top-left corner. */
  hole?: boolean;
  style?: ViewStyle | ViewStyle[] | undefined;
};

const LIFT_PX = 2;

/** The punched hole and its bit of string, drawn with Views (no SVG dependency):
 * a small ring, then two quarter-arcs that read as a knotted loop. */
function TagHole(): React.ReactElement {
  const colors = useColors();
  const stroke = colors.textTertiary;
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ position: "absolute", top: 7, left: 16, width: 32, height: 32 }}
    >
      <View style={{ position: "absolute", top: 0, left: 0, width: 11, height: 11, borderRadius: 6, borderWidth: 2, borderColor: stroke }} />
      <View
        style={{
          position: "absolute",
          top: 10,
          left: 3,
          width: 13,
          height: 15,
          borderLeftWidth: 1.5,
          borderBottomWidth: 1.5,
          borderBottomLeftRadius: 13,
          borderColor: stroke,
        }}
      />
      <View
        style={{
          position: "absolute",
          top: 17,
          left: 13,
          width: 9,
          height: 8,
          borderRightWidth: 1.5,
          borderTopWidth: 1.5,
          borderTopRightRadius: 9,
          borderColor: stroke,
        }}
      />
    </View>
  );
}

/**
 * A card as a luggage tag: square top-left corner (where the hole is punched),
 * `radii.tag` elsewhere, no border — the paper-on-paper shadow does the
 * separating. `overflow` stays visible so the hole can sit over a photo.
 */
export function TagCard({ interactive = false, tilt = 1, hole = true, style, children, ...rest }: TagCardProps): React.ReactElement {
  const colors = useColors();
  const motion = useMotion();
  const lift = useSharedValue(0);
  const [hovered, setHovered] = React.useState(false);
  const tiltDeg = tilt * motion.tagTiltDeg;

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -LIFT_PX * lift.value }, { rotate: `${tiltDeg * lift.value}deg` }],
  }));

  const setLifted = (up: boolean): void => {
    if (!interactive || motion.reduce) return;
    setHovered(up);
    lift.value = withTiming(up ? 1 : 0, { duration: motion.liftMs });
  };

  // `onMouseEnter`/`onMouseLeave` are react-native-web View props (forwarded
  // to the DOM node); RN's `ViewProps` doesn't declare them, so they're
  // spread in as an opaque object rather than typed as RN props.
  const hoverProps = interactive ? ({ onMouseEnter: () => setLifted(true), onMouseLeave: () => setLifted(false) } as object) : null;

  const base: ViewStyle = {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 0,
    borderTopRightRadius: radii.tag,
    borderBottomRightRadius: radii.tag,
    borderBottomLeftRadius: radii.tag,
    ...({
      boxShadow: hovered ? shadow.cardHover(colors.shadowStrong) : shadow.card(colors.shadow),
      transitionProperty: "box-shadow",
      transitionDuration: `${motion.liftMs}ms`,
    } as ViewStyle),
  };

  return (
    <Animated.View style={[base, animatedStyle, ...(Array.isArray(style) ? style : [style ?? {}])]} {...hoverProps} {...rest}>
      {children}
      {hole ? <TagHole /> : null}
    </Animated.View>
  );
}

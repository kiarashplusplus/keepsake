// The NATIVE print. The web gets `Print.web.tsx`, which draws the same
// object with CSS instead of Reanimated — see that file for why (this one's
// entrance animation starts at `opacity: 0`, which in a static render means
// the exported HTML is there but invisible).
//
// The v3 identity's one recurring object: an instant-film print. White
// frame, thick bottom border baked into the caller's own padding, square
// corners, a warm shadow cast down-and-right, and two translucent tape
// corners holding it to the table. Drops onto the table on first render and
// straightens by a degree on hover — see packages/tokens/src/motion.ts.
import * as React from "react";
import { type ViewProps, type ViewStyle } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { radii, shadow } from "@keepsake/tokens/radii";
import { useColors } from "@/ui/theme";
import { useMotion } from "@/ui/MotionProvider";
import { TapeCorners } from "@/ui/PrintTape";

export type PrintProps = Omit<ViewProps, "style"> & {
  /** Lifts 2px and straightens by 1° on hover. Off under reduce-motion. */
  interactive?: boolean;
  /** The print's resting tilt in degrees, e.g. from `tiltDegForId`. */
  tiltDeg?: number;
  /** Two translucent masking-tape corners holding it to the table. */
  tape?: boolean;
  style?: ViewStyle | ViewStyle[] | undefined;
};

export function Print({ interactive = false, tiltDeg = 0, tape = true, style, children, ...rest }: PrintProps): React.ReactElement {
  const colors = useColors();
  const motion = useMotion();
  const lift = useSharedValue(0);
  const drop = useSharedValue(motion.reduce ? 1 : 0);
  const [hovered, setHovered] = React.useState(false);

  React.useEffect(() => {
    drop.value = withSpring(1, motion.dropSpring);
    // Runs once on mount; `motion.dropSpring` is stable per render of the
    // provider, not per print, so it's intentionally left out of deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const straighten = interactive ? Math.sign(tiltDeg) * Math.min(Math.abs(tiltDeg), motion.tiltDeg) : 0;

  const animatedStyle = useAnimatedStyle(() => {
    const scale = 1.03 - 0.03 * drop.value;
    const settledTilt = tiltDeg * drop.value;
    const straightenedTilt = settledTilt - straighten * lift.value;
    return {
      opacity: drop.value,
      transform: [{ translateY: -2 * lift.value }, { rotate: `${straightenedTilt}deg` }, { scale }],
    };
  });

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
    backgroundColor: colors.print,
    borderRadius: radii.print,
    ...({
      boxShadow: `inset 0px 0px 0px 1px rgba(0,0,0,0.08), ${hovered ? shadow.cardHover(colors.shadow) : shadow.card(colors.shadow)}`,
      transitionProperty: "box-shadow",
      transitionDuration: `${motion.liftMs}ms`,
    } as ViewStyle),
  };

  return (
    <Animated.View style={[base, animatedStyle, ...(Array.isArray(style) ? style : [style ?? {}])]} {...hoverProps} {...rest}>
      {children}
      {tape ? <TapeCorners /> : null}
    </Animated.View>
  );
}

/** Kept as an alias of `Print` for anything still written against the v2
 * "tag" name. */
export const TagCard = Print;

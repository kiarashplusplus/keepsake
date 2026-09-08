// The web print. Same object as `Print.tsx` — white frame, warm shadow, tape
// corners, a tilt on the table, a 2px lift on hover — drawn with CSS instead
// of Reanimated.
//
// ## Why the web needs its own
//
// The native `Print` animates its entrance from a Reanimated shared value
// that starts at 0, and that value IS the opacity. Under `expo export`'s
// static render there is no effect to move it, so every print in the
// exported HTML shipped as `opacity: 0` — the markup existed and none of it
// was visible until the JS bundle hydrated and the drop animation ran. On a
// feed of other people's things, that is the whole page.
//
// So on the web the entrance is a CSS animation (`ks-print-drop`, declared
// in `app/+html.tsx`'s ROOT_CSS): it starts at the browser's first paint
// with no JavaScript at all, it costs nothing to hydrate, and
// `prefers-reduced-motion` turns it off in the stylesheet rather than
// through a provider the server cannot read. The keyframes animate `opacity`
// and the individual `scale` property — never `transform` — because the
// print's tilt lives in an inline `transform: rotate(...)` and an animation
// on `transform` would replace it and stand every card up straight.
//
// The hover lift is a plain CSS transition on the same inline transform.
// Reduce-motion is honoured through `useMotion()` here, as before: hover is
// a client-only interaction, so there is no server render to disagree with.
import * as React from "react";
import { View, type ViewProps, type ViewStyle } from "react-native";
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
  const [hovered, setHovered] = React.useState(false);

  const straighten = interactive && !motion.reduce ? Math.sign(tiltDeg) * Math.min(Math.abs(tiltDeg), motion.tiltDeg) : 0;
  const lifted = hovered && interactive && !motion.reduce;
  const restingTilt = tiltDeg - (lifted ? straighten : 0);

  // `onMouseEnter`/`onMouseLeave` are react-native-web View props (forwarded
  // to the DOM node); RN's `ViewProps` doesn't declare them, so they're
  // spread in as an opaque object rather than typed as RN props.
  const hoverProps = interactive ? ({ onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) } as object) : null;

  // `data-ks-print="drop"` is what ROOT_CSS's entrance animation selects. A
  // data attribute rather than a class because react-native-web builds
  // `className` itself from the style prop and offers `dataSet` as the
  // supported way to put an attribute on the node — and, like the hover
  // props above, `dataSet` is a react-native-web prop that RN's `ViewProps`
  // does not declare, so it is spread in as an opaque object.
  const dataProps = { dataSet: { ksPrint: "drop" } } as object;

  const base: ViewStyle = {
    backgroundColor: colors.print,
    borderRadius: radii.print,
    transform: [{ translateY: lifted ? -2 : 0 }, { rotate: `${restingTilt}deg` }],
    ...({
      boxShadow: `inset 0px 0px 0px 1px rgba(0,0,0,0.08), ${hovered ? shadow.cardHover(colors.shadow) : shadow.card(colors.shadow)}`,
      transitionProperty: "box-shadow, transform",
      transitionDuration: `${motion.liftMs}ms`,
    } as ViewStyle),
  };

  return (
    <View style={[base, ...(Array.isArray(style) ? style : [style ?? {}])]} {...dataProps} {...hoverProps} {...rest}>
      {children}
      {tape ? <TapeCorners /> : null}
    </View>
  );
}

/** Kept as an alias of `Print` for anything still written against the v2
 * "tag" name. */
export const TagCard = Print;

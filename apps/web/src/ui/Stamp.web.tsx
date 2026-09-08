// The web stamp. Same object as `Stamp.tsx` — a face-down print bearing a
// rubber stamp, restless while under review, settling flat with a flip once
// a decision lands — drawn with CSS instead of Reanimated
// (`ks-stamp-breathe`/`ks-stamp-settle`, declared in `app/+html.tsx`'s
// ROOT_CSS) so the loop and the settle transition cost no JS runtime on
// web. `prefers-reduced-motion` is honoured both in the stylesheet and
// here, by omitting the data attribute entirely and resting at the same
// flat `rotate(0deg) scaleX(1)` the reanimated version used for every
// state under reduce-motion.
import * as React from "react";
import { View, type ViewStyle } from "react-native";
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

  const restingStyle: ViewStyle = motion.reduce ? { transform: [{ rotate: "0deg" }, { scaleX: 1 }] } : {};
  const dataProps = motion.reduce ? null : ({ dataSet: { ksStamp: state } } as object);

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
    <View style={restingStyle} accessibilityRole="image" accessibilityLabel={`Stamp: ${label}`} {...dataProps}>
      <View style={card}>
        <StampMark label={label} />
      </View>
    </View>
  );
}

/** Kept as an alias of `Stamp`/`StampState` for anything still written
 * against the v2 "seal" name. */
export const Seal = Stamp;
export type SealState = StampState;

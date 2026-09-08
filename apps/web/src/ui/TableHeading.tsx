import * as React from "react";
import { View, type ViewStyle } from "react-native";
import { radii, shadow } from "@keepsake/tokens/radii";
import { space } from "@keepsake/tokens/spacing";
import { useColors } from "@/ui/theme";
import { Eyebrow } from "@/ui/Eyebrow";
import { Text } from "@/ui/Text";

export type TableHeadingProps = {
  /** The heading words. */
  children: React.ReactNode;
  /** A quiet caption alongside them, e.g. "6 pieces on the table". */
  note?: string;
  /** The strip's resting lean, in degrees. */
  tiltDeg?: number;
  style?: ViewStyle;
};

/**
 * A section heading that sits out on the tabletop rather than inside a card
 * — printed on its own small paper strip, so it obeys the identity's own
 * rule instead of breaking it.
 *
 * That rule is `packages/tokens/src/colors.ts`'s: every object on the table
 * keeps its colour in both themes, and only the table beneath them changes,
 * "so dark mode never asks black ink to sit on a dark table". It held
 * everywhere except three section headings, which rendered a bare `Eyebrow`
 * (`accent2Text`, near-black, constant by design) straight onto `bg` — the
 * `/mine` group headings, the feed's aspect shelves, and the feed hero's
 * "Everything nearby". Nothing caught it because `e2e/a11y.spec.ts` never
 * scanned `/mine` at all, in either mode; it does now.
 *
 * Contrast, computed with `contrastRatio()` from `@keepsake/tokens/contrast`
 * — the same helper `packages/tokens/test/contrast.test.ts` uses, so these
 * are token arithmetic and not eyeballed off a screenshot. AA wants 4.5:1.
 *
 *   what it renders now:
 *     accent2Text  #1B1815  on surface #F1E6CC  14.25:1   the heading itself
 *     textTertiary #6C6150  on surface #F1E6CC   4.89:1   the `note`
 *   what it replaces (a bare Eyebrow on the table):
 *     accent2Text  #1B1815  on bg light #D2BC97  9.58:1   fine, always was
 *     accent2Text  #1B1815  on bg dark  #2B2119  1.12:1   invisible
 *
 * `surface` is a constant token, so the first two numbers are the numbers in
 * BOTH themes — that is the whole point of putting the words on paper. The
 * 1.12:1 is the failure #216 was filed for; the issue measured ~1.11:1 off a
 * quality-85 JPEG of the dark `/mine` frame, which is the same number.
 *
 * The fix is deliberately the paper, not a new colour. Giving the eyebrow a
 * light-on-dark value would have made these the only text in the product
 * that flips — the one thing the palette is built not to do — and it would
 * have had to flip for the underline beneath it too. A label on a strip of
 * card is what the rest of the product already does with words, and it
 * reads the same under either lamp.
 */
export function TableHeading({ children, note, tiltDeg = -0.5, style }: TableHeadingProps): React.ReactElement {
  const colors = useColors();

  return (
    <View
      style={[
        {
          alignSelf: "flex-start",
          maxWidth: "100%",
          flexDirection: "row",
          alignItems: "baseline",
          flexWrap: "wrap",
          gap: space.sm,
          backgroundColor: colors.surface,
          borderRadius: radii.sm,
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
          transform: [{ rotate: `${tiltDeg}deg` }],
          ...({ boxShadow: `inset 0px 0px 0px 1px rgba(0,0,0,0.08), ${shadow.tag(colors.shadow)}` } as ViewStyle),
        },
        style,
      ]}
    >
      <Eyebrow tick>{children}</Eyebrow>
      {note !== undefined ? (
        <Text variant="caption" color="textTertiary">
          {note}
        </Text>
      ) : null}
    </View>
  );
}

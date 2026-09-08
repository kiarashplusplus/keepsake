import * as React from "react";
import { View } from "react-native";
import { space } from "@keepsake/tokens/spacing";
import { useColors } from "@/ui/theme";
import { Text } from "@/ui/Text";

/**
 * The "meet somewhere public, tell someone the plan, keep talking here" copy,
 * set as a note the reader is meant to read.
 *
 * WHY THIS EXISTS (issue #224, item 2)
 *
 * Both safety paragraphs in `features/request/RequestSheet.tsx` were
 * `<Text variant="caption" color="textTertiary">` — 12px CourierPrime in
 * `textTertiary #6C6150`, the faintest text colour in the palette, sitting
 * inside a sheet where everything around them is Fraunces at 16px. That is
 * the house style for distances, dates and counts; applied here it set the
 * single most consequential sentence in the product in the exact register
 * people have learned to skip. The wording was already careful, so #224 is
 * about how it is SET, not what it says: this component changes typeface,
 * size, colour and framing, and touches no word of the copy.
 *
 * THE THREE CHOICES, AND WHY
 *
 * 1. `variant="body"` — Fraunces 16/25, the same measure as the prose it sits
 *    beside, rather than `bodySm`. Stepping it down would just be a quieter
 *    version of the same "this is the small print" signal.
 *
 * 2. `color="inkSoft"` (#3A332B) — **10.0:1** against the sheet's own fill
 *    (`surface #FAF6EE`, which is what `ui/Sheet.tsx` paints and is constant
 *    in light and dark, so this one number holds in both themes). Computed
 *    with `packages/tokens/src/contrast.ts`'s `contrastRatio()`. For
 *    comparison: the `textTertiary` it replaces is 4.9:1 on the same fill —
 *    a hair over the AA floor and the palette's faintest option, which is
 *    what #224 objected to. `inkSoft` rather than full `ink` (14.3:1) keeps
 *    it legible as an aside beside the body copy without whispering.
 *
 * 3. A stamp-red left rule, not `Surface.tsx`'s `Sunken`. Both idioms were on
 *    the table and this one is forced by the palette, not preference:
 *    `Sunken` fills with `tableEdge`, one of the handful of tokens that DO
 *    flip between light and dark (`#B89D74` day, `#1C140F` night — see
 *    `packages/tokens/src/colors.ts`'s file header). Ink never inverts here,
 *    so ink text on a night-coloured well measures about 1.1:1 and the note
 *    would vanish in dark mode — the precise failure the "objects on the
 *    table never change colour" rule exists to prevent. The rule instead
 *    borrows the idiom the consent banner already uses for the one paragraph
 *    it needs a visitor to actually read (`.ks-consent__note` in
 *    `public/consent.js`, a 2px stamp-red left border): it marks the block
 *    out without putting text on any new ground, so the 10.0:1 above is the
 *    only pair to verify. `accent #A9432E` is decorative here and carries no
 *    text, which is the only way this palette permits it to be used.
 *
 * Logical properties (`borderStartWidth`/`paddingStart`) per the design
 * system's RTL rule, so a locale flip moves the rule to the other edge.
 */
export function SafetyNote({ children }: { children: string }): React.ReactElement {
  const colors = useColors();

  return (
    <View
      style={{
        borderStartWidth: 3,
        borderStartColor: colors.accent,
        paddingStart: space.md,
      }}
    >
      <Text variant="body" color="inkSoft">
        {children}
      </Text>
    </View>
  );
}

// Issue #135: the attributes the vision model read off the cover photo,
// shown on the item page. They have been stored in `listing_aspects` and
// carried on `PublicListing.aspects` since #36/#37, and until now nothing
// anywhere rendered one — the first real production listing showed a visitor
// the single word "OTHER" for a spool plainly printed KASTKING, SUPER POWER,
// 30 LBS 327 YDS.
//
// Deliberately a *label*, not a spec table. "Anything that makes a listing
// feel like a classified ad is wrong" (AGENTS.md), and a bordered grid of
// name/value cells is exactly that. This is the small typed annotation on
// the back of a museum card: mono, quiet, name in the pencil grey, value in
// ink, no rules and no boxes. The story stays the loudest thing on the page.
//
// Renders nothing at all for a listing with no aspects — which is a normal
// listing, not a broken one. The prompt is told to return an empty array
// rather than guess, and `apps/api/test/aspects.test.ts` holds open the
// guarantee that zero aspects is a fully-visible listing.
import * as React from "react";
import { View } from "react-native";
import type { Aspect } from "@keepsake/contracts/photo";
import { space } from "@keepsake/tokens/spacing";
import { Text } from "@/ui/Text";

/** Wide enough for the longest name the prompt's vocabulary suggests
 * ("material"), so the values line up as a column rather than ragging. */
const NAME_COLUMN_WIDTH = 96;

export function AspectList({ aspects }: { aspects: Aspect[] }): React.ReactElement | null {
  if (aspects.length === 0) return null;

  return (
    <View style={{ gap: space.xs }} testID="aspect-list">
      {aspects.map((aspect) => (
        <View key={`${aspect.name}:${aspect.value}`} style={{ flexDirection: "row", alignItems: "baseline", gap: space.md }}>
          <Text variant="label" color="textTertiary" style={{ width: NAME_COLUMN_WIDTH }}>
            {aspect.name}
          </Text>
          <Text variant="caption" color="inkSoft" style={{ flex: 1 }}>
            {aspect.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

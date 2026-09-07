import * as React from "react";
import { ScrollView, useWindowDimensions, View } from "react-native";
import { CATEGORIES, CATEGORY_LABELS, type Category } from "@keepsake/contracts/listing";
import { space } from "@keepsake/tokens/spacing";
import { Chip } from "@/ui/Chip";

export type CategoryChipsProps = {
  value: Category | null;
  onChange: (category: Category | null) => void;
};

/**
 * Below this, the chips scroll sideways instead of wrapping. Issue #136 took
 * the list from five categories to eleven, and thirteen wrapped chips (the
 * eleven plus "All", plus "Other") stacked four rows deep on a phone, above
 * the location controls and before a visitor had seen a single keepsake —
 * the feed's own filters pushing the feed itself off the screen. On a
 * desktop width they still wrap, where there is room for them on one or two
 * lines and a horizontal scroller would be the worse of the two.
 */
const SCROLL_BELOW_WIDTH = 700;

export function CategoryChips({ value, onChange }: CategoryChipsProps): React.ReactElement {
  const { width } = useWindowDimensions();
  const scroll = width < SCROLL_BELOW_WIDTH;

  const chips = (
    <>
      <Chip label="All" selected={value === null} onPress={() => onChange(null)} />
      {CATEGORIES.map((category) => (
        <Chip
          key={category}
          label={CATEGORY_LABELS[category]}
          selected={value === category}
          onPress={() => onChange(value === category ? null : category)}
        />
      ))}
    </>
  );

  if (scroll) {
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        // `paddingEnd` so the last chip doesn't sit flush against the card's
        // edge when scrolled to the end.
        contentContainerStyle={{ flexDirection: "row", gap: space.sm, paddingEnd: space.sm }}
      >
        {chips}
      </ScrollView>
    );
  }

  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>{chips}</View>;
}

import * as React from "react";
import { View } from "react-native";
import { CATEGORIES, CATEGORY_LABELS, type Category } from "@keepsake/contracts/listing";
import { space } from "@keepsake/tokens/spacing";
import { Chip } from "@/ui/Chip";

export type CategoryChipsProps = {
  value: Category | null;
  onChange: (category: Category | null) => void;
};

/** "All" plus the five categories; selecting the active one again clears it. */
export function CategoryChips({ value, onChange }: CategoryChipsProps): React.ReactElement {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
      <Chip label="All" selected={value === null} onPress={() => onChange(null)} />
      {CATEGORIES.map((category) => (
        <Chip
          key={category}
          label={CATEGORY_LABELS[category]}
          selected={value === category}
          onPress={() => onChange(value === category ? null : category)}
        />
      ))}
    </View>
  );
}

/**
 * Issue #155 — the one place a giver can say what their own object is.
 *
 * `category` had exactly one kind of writer before this: the model, through
 * the cover-photo suggestion at create and `resuggest` afterwards. #35
 * removed the give flow's picker for a good reason — it was a step in a flow
 * whose product is the story, and it asked a hurried giver to categorise
 * before they had seen what the model thought — but it left no human path at
 * any layer. The first real production listing showed a visitor the single
 * word OTHER (#135).
 *
 * So the correction lives *here*, on a listing that already exists, rather
 * than back in the flow: the giver sees what was decided about their object
 * and can change it, and the give flow stays at five steps. The copy says
 * which of the two it is, because "we guessed" invites a correction and
 * "you chose" does not.
 */
import * as React from "react";
import { View } from "react-native";
import { CATEGORIES, CATEGORY_LABELS, type Category } from "@keepsake/contracts/listing";
import { space } from "@keepsake/tokens/spacing";
import { Text } from "@/ui/Text";
import { Eyebrow } from "@/ui/Eyebrow";
import { Button } from "@/ui/Button";
import { Chip } from "@/ui/Chip";
import { Sheet } from "@/ui/Sheet";

export interface CategorySectionProps {
  category: Category;
  /** `null` while the model's suggestion stands — see `OwnerListing`. */
  categoryChosenAt: number | null;
  /** Given away: the object has changed hands and the listing is a record now. */
  editable: boolean;
  busy: boolean;
  onChange: (category: Category) => Promise<void>;
  rule: object;
}

export function CategorySection({
  category,
  categoryChosenAt,
  editable,
  busy,
  onChange,
  rule,
}: CategorySectionProps): React.ReactElement {
  const [picking, setPicking] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  async function choose(next: Category): Promise<void> {
    setSaving(true);
    try {
      await onChange(next);
      setPicking(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={{ gap: space.sm }}>
      <View style={rule}>
        <Eyebrow>Category</Eyebrow>
      </View>
      <Text variant="title">{CATEGORY_LABELS[category]}</Text>
      <Text variant="body" color="textSecondary">
        {categoryChosenAt === null
          ? "We guessed this from your photo. Change it if it's wrong."
          : "You chose this, so we'll leave it alone."}
      </Text>
      {editable ? (
        <View style={{ flexDirection: "row" }}>
          <Button label="Change category" variant="secondary" disabled={busy || saving} onPress={() => setPicking(true)} />
        </View>
      ) : null}

      <Sheet visible={picking} onClose={() => setPicking(false)} title="What is it?">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          {CATEGORIES.map((option) => (
            <Chip
              key={option}
              label={CATEGORY_LABELS[option]}
              selected={option === category}
              onPress={() => {
                void choose(option);
              }}
            />
          ))}
        </View>
      </Sheet>
    </View>
  );
}

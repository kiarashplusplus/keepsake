// M2: replace with real feed (keyset pagination, FTS search, geo radius —
// see the build plan's "Web app" section). This screen exists only to prove
// the design system end to end: the story-excerpt card, chips, seal.
import * as React from "react";
import { View } from "react-native";
import { space } from "@keepsake/tokens/spacing";
import { ReadableWidth } from "@/ui/ReadableWidth";
import { Text } from "@/ui/Text";
import { Card } from "@/ui/Surface";
import { Skeleton } from "@/ui/Skeleton";
import { Chip } from "@/ui/Chip";
import { Seal } from "@/ui/Seal";

const CATEGORIES = ["Books & letters", "Jewelry & watches", "Home & kitchen", "Photos/art & handmade", "Other"] as const;

const DEMO_CARDS = [
  { title: "A hand-thrown mug", excerpt: "My grandmother's hands made this cup every morning for forty years.", caption: "Somerville, MA · 0.8 mi" },
  { title: "Leather-bound journal", excerpt: "Half-full of a stranger's handwriting I never got to ask about.", caption: "Cambridge, MA · 2 mi" },
  { title: "Brass compass", excerpt: "It pointed the way on a trip I never finished.", caption: "Boston, MA · 3 mi" },
  { title: "Wool quilt, hand-stitched", excerpt: "Every square is a scrap from a dress someone wore once.", caption: "Medford, MA · 4 mi" },
  { title: "Set of watercolor postcards", excerpt: "Painted on a porch that doesn't exist anymore.", caption: "Arlington, MA · 5 mi" },
  { title: "Pocket watch, stopped at 3:14", excerpt: "It kept perfect time until the day it simply chose to stop.", caption: "Newton, MA · 6 mi" },
] as const;

export default function Feed(): React.ReactElement {
  const [selectedCategory, setSelectedCategory] = React.useState<string | null>(null);

  return (
    <ReadableWidth variant="grid" style={{ paddingVertical: space.xxl, gap: space.xxl }}>
      <View style={{ gap: space.md }}>
        <Text variant="displayLg">Give a keepsake a second life.</Text>
        <Text variant="bodyLg" color="textSecondary">
          Photograph something you’re ready to let go of, tell its story, and let someone nearby give it a home.
        </Text>
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        {CATEGORIES.map((category) => (
          <Chip
            key={category}
            label={category}
            selected={selectedCategory === category}
            onPress={() => setSelectedCategory((current) => (current === category ? null : category))}
          />
        ))}
      </View>

      <View style={{ alignItems: "center", paddingVertical: space.lg }}>
        <Seal state="breathing" />
        <Text variant="caption" color="textTertiary" style={{ marginTop: space.sm }}>
          Reviewing demo — this is what a listing looks like while it’s held for a look.
        </Text>
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg }}>
        {DEMO_CARDS.map((item) => (
          <Card key={item.title} style={{ width: 320, padding: space.md, gap: space.sm }}>
            <Skeleton style={{ aspectRatio: 4 / 5, width: "100%" }} />
            <Text variant="storyExcerpt" color="textSecondary">
              “{item.excerpt}”
            </Text>
            <Text variant="title">{item.title}</Text>
            <Text variant="caption" color="textTertiary">
              {item.caption}
            </Text>
          </Card>
        ))}
      </View>
    </ReadableWidth>
  );
}

// M2: replace with real feed (keyset pagination, FTS search, geo radius —
// see the build plan's "Web app" section). This screen exists only to prove
// the design system end to end: the hero, the tag cards, the seal, a torn edge.
import * as React from "react";
import { useWindowDimensions, View, type ViewStyle } from "react-native";
import { Link } from "expo-router";
import { measure, sectionRhythm, space } from "@keepsake/tokens/spacing";
import { radii } from "@keepsake/tokens/radii";
import { ReadableWidth } from "@/ui/ReadableWidth";
import { Text } from "@/ui/Text";
import { Eyebrow } from "@/ui/Eyebrow";
import { Button } from "@/ui/Button";
import { TagCard } from "@/ui/TagCard";
import { DeckleRule } from "@/ui/DeckleRule";
import { Skeleton } from "@/ui/Skeleton";
import { Chip } from "@/ui/Chip";
import { Seal } from "@/ui/Seal";
import { useColors } from "@/ui/theme";

const CATEGORIES = ["Books & letters", "Jewelry & watches", "Home & kitchen", "Photos/art & handmade", "Other"] as const;

const DEMO_CARDS = [
  { title: "A hand-thrown mug", excerpt: "My grandmother's hands made this cup every morning for forty years.", caption: "Somerville, MA · 0.8 mi" },
  { title: "Leather-bound journal", excerpt: "Half-full of a stranger's handwriting I never got to ask about.", caption: "Cambridge, MA · 2 mi" },
  { title: "Brass compass", excerpt: "It pointed the way on a trip I never finished.", caption: "Boston, MA · 3 mi" },
  { title: "Wool quilt, hand-stitched", excerpt: "Every square is a scrap from a dress someone wore once.", caption: "Medford, MA · 4 mi" },
  { title: "Set of watercolor postcards", excerpt: "Painted on a porch that doesn't exist anymore.", caption: "Arlington, MA · 5 mi" },
  { title: "Pocket watch, stopped at 3:14", excerpt: "It kept perfect time until the day it simply chose to stop.", caption: "Newton, MA · 6 mi" },
] as const;

const NARROW_BREAKPOINT = 640;

export default function Feed(): React.ReactElement {
  const [selectedCategory, setSelectedCategory] = React.useState<string | null>(null);
  const colors = useColors();
  const { width } = useWindowDimensions();
  const narrow = width < NARROW_BREAKPOINT;

  // The site's card-photo ground: sunken paper warming into accentSoft, so a
  // photo-less tag still has some life in it (and isn't a black slab in dark).
  // `backgroundImage` is DOM-only; react-native-web passes it straight through.
  const photoGround = {
    aspectRatio: 4 / 5,
    width: "100%",
    borderRadius: 0,
    borderTopRightRadius: radii.tag,
    backgroundImage: `linear-gradient(160deg, ${colors.surfaceSunken} 0%, ${colors.accentSoft} 100%)`,
  } as unknown as ViewStyle;

  return (
    <ReadableWidth variant="grid" style={{ paddingTop: narrow ? sectionRhythm.normal : sectionRhythm.loose, paddingBottom: sectionRhythm.bookend }}>
      {/* Hero: text on the left ~7 of 12 columns, like the site. */}
      <View style={{ maxWidth: 680, gap: space.lg }}>
        <Eyebrow tick>A free gifting marketplace</Eyebrow>
        <Text variant={narrow ? "displayLg" : "displayXl"}>Give a keepsake a second life.</Text>
        <Text variant="bodyLg" color="textSecondary" style={{ maxWidth: measure.heroText }}>
          Some things are too full of memory to sell and too good to throw away. Post the story, and let someone nearby who’ll love it come
          and get it.
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.xl, marginTop: space.sm }}>
          <Link href="/give" asChild>
            <Button label="Give something" />
          </Link>
          <Button
            label="How it works"
            variant="link"
            onPress={() => {
              if (typeof window !== "undefined") window.location.assign("/about");
            }}
          />
        </View>
      </View>

      <View style={{ marginTop: sectionRhythm.tight, gap: space.md }}>
        <Eyebrow>Browse by</Eyebrow>
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
      </View>

      <DeckleRule style={{ marginTop: sectionRhythm.normal, marginBottom: sectionRhythm.normal }} />

      <View style={{ flexDirection: narrow ? "column" : "row", alignItems: "center", gap: space.xl }}>
        <Seal state="breathing" />
        <View style={{ flex: narrow ? undefined : 1, gap: space.xs, alignItems: narrow ? "center" : "flex-start", maxWidth: measure.heroText }}>
          <Eyebrow>Under review</Eyebrow>
          <Text variant="storyExcerpt" color="textSecondary" style={narrow ? { textAlign: "center" } : undefined}>
            Every keepsake gets a look before it goes live. The seal breathes while it’s held, and settles once it’s out.
          </Text>
        </View>
      </View>

      <View style={{ marginTop: sectionRhythm.loose, gap: space.xl }}>
        <View style={{ gap: space.sm }}>
          <Eyebrow>Nearby</Eyebrow>
          <Text variant="displayLg">What’s waiting nearby</Text>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xxl }}>
          {DEMO_CARDS.map((item, index) => (
            <TagCard
              key={item.title}
              interactive
              tilt={index % 2 === 0 ? 1 : -1}
              testID={index === 0 ? "feed-card-first" : undefined}
              style={{ flexGrow: 1, flexBasis: 280, maxWidth: narrow ? "100%" : 360 }}
            >
              <Skeleton style={photoGround} />
              <View style={{ padding: space.lg, gap: space.xs, borderTopWidth: 1, borderStyle: "dashed", borderTopColor: colors.rule }}>
                <Text variant="storyExcerpt" color="textSecondary" hangingPunctuation>
                  “{item.excerpt}”
                </Text>
                <Text variant="title">{item.title}</Text>
                <Text variant="caption" color="textTertiary">
                  {item.caption}
                </Text>
              </View>
            </TagCard>
          ))}
        </View>
      </View>
    </ReadableWidth>
  );
}

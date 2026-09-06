// The v2 tag card wherever a listing appears in the feed: photo, one line of
// the story in italic with hanging quotes, title, then a caption line.
import * as React from "react";
import { Pressable, View } from "react-native";
import { Image as ExpoImage } from "expo-image";
import { Link } from "expo-router";
import type { PublicListing } from "@keepsake/contracts/listing";
import { space } from "@keepsake/tokens/spacing";
import { radii } from "@keepsake/tokens/radii";
import { Text } from "@/ui/Text";
import { TagCard } from "@/ui/TagCard";
import { useColors } from "@/ui/theme";
import { useMotion } from "@/ui/MotionProvider";
import { clampCardAspectRatio } from "@/lib/masonry";
import { storyExcerpt } from "@/lib/storyExcerpt";
import { formatDistance } from "@/lib/geo";

export type ListingCardProps = {
  listing: PublicListing;
  tilt?: 1 | -1;
  testID?: string | undefined;
};

function caption(listing: PublicListing): string {
  const place = listing.admin1 !== null ? `${listing.place_name}, ${listing.admin1}` : listing.place_name;
  return listing.distance_mi !== undefined ? `${place} · ${formatDistance(listing.distance_mi)}` : place;
}

export function ListingCard({ listing, tilt = 1, testID }: ListingCardProps): React.ReactElement {
  const colors = useColors();
  const motion = useMotion();
  const cover = listing.photos[0];
  const aspectRatio = cover !== undefined ? clampCardAspectRatio(cover.width, cover.height) : 1;

  return (
    <Link href={{ pathname: "/item/[id]", params: { id: listing.id } }} asChild>
      <Pressable accessibilityRole="link" accessibilityLabel={listing.title} testID={testID}>
        <TagCard interactive tilt={tilt} style={{ width: "100%" }}>
          <View
            style={{
              width: "100%",
              aspectRatio,
              overflow: "hidden",
              borderTopRightRadius: radii.tag,
              backgroundColor: colors.surfaceSunken,
            }}
          >
            <ExpoImage
              source={cover !== undefined ? cover.url_thumb : null}
              placeholder={cover !== undefined ? { blurhash: cover.blurhash } : null}
              style={{ width: "100%", height: "100%" }}
              contentFit="cover"
              transition={motion.imageFadeMs}
              accessibilityLabel=""
            />
            {listing.status === "given" ? (
              <View
                style={{
                  position: "absolute",
                  top: space.sm,
                  right: space.sm,
                  backgroundColor: colors.foil,
                  borderRadius: radii.sm,
                  paddingHorizontal: space.sm,
                  paddingVertical: space.xxs,
                }}
              >
                <Text variant="eyebrow" color="onFoil" style={{ fontSize: 11, lineHeight: 14 }}>
                  Given
                </Text>
              </View>
            ) : null}
          </View>
          <View style={{ padding: space.lg, gap: space.xs, borderTopWidth: 1, borderStyle: "dashed", borderTopColor: colors.rule }}>
            <Text variant="storyExcerpt" color="textSecondary" numberOfLines={2} hangingPunctuation>
              “{storyExcerpt(listing.story)}”
            </Text>
            <Text variant="title" numberOfLines={1}>
              {listing.title}
            </Text>
            <Text variant="caption" color="textTertiary">
              {caption(listing)}
            </Text>
          </View>
        </TagCard>
      </Pressable>
    </Link>
  );
}

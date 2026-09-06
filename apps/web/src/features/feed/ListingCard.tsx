// The v3 print wherever a listing appears in the feed: photo behind glass,
// a thick bottom border carrying the caption in mono, tilted a few degrees
// (deterministic from the listing id) and taped to the table.
import * as React from "react";
import { Pressable, View } from "react-native";
import { Image as ExpoImage } from "expo-image";
import { Link } from "expo-router";
import type { PublicListing } from "@keepsake/contracts/listing";
import { space } from "@keepsake/tokens/spacing";
import { motion } from "@keepsake/tokens/motion";
import { Text } from "@/ui/Text";
import { Print } from "@/ui/Print";
import { useColors } from "@/ui/theme";
import { useMotion } from "@/ui/MotionProvider";
import { clampCardAspectRatio, tiltDegForId } from "@/lib/masonry";
import { storyExcerpt } from "@/lib/storyExcerpt";
import { formatDistance } from "@/lib/geo";

export type ListingCardProps = {
  listing: PublicListing;
  testID?: string | undefined;
};

function caption(listing: PublicListing): string {
  const place = listing.admin1 !== null ? `${listing.place_name}, ${listing.admin1}` : listing.place_name;
  return listing.distance_mi !== undefined ? `${place} · ${formatDistance(listing.distance_mi)}` : place;
}

export function ListingCard({ listing, testID }: ListingCardProps): React.ReactElement {
  const colors = useColors();
  const rnMotion = useMotion();
  const cover = listing.photos[0];
  const aspectRatio = cover !== undefined ? clampCardAspectRatio(cover.width, cover.height) : 1;
  const tiltDeg = tiltDegForId(listing.id, motion.tiltRangeDeg);

  return (
    <Link href={{ pathname: "/item/[id]", params: { id: listing.id } }} asChild>
      <Pressable accessibilityRole="link" accessibilityLabel={listing.title} testID={testID}>
        <Print interactive tiltDeg={tiltDeg} style={{ width: "100%", padding: 10 }}>
          <View
            style={{
              width: "100%",
              aspectRatio,
              overflow: "hidden",
              backgroundColor: colors.tableEdge,
            }}
          >
            <ExpoImage
              source={cover !== undefined ? cover.url_thumb : null}
              placeholder={cover !== undefined ? { blurhash: cover.blurhash } : null}
              style={{ width: "100%", height: "100%" }}
              contentFit="cover"
              transition={rnMotion.imageFadeMs}
              accessibilityLabel=""
            />
            {listing.status === "given" ? (
              <View
                style={{
                  position: "absolute",
                  top: space.sm,
                  right: space.sm,
                  borderWidth: 2,
                  borderColor: colors.accent,
                  backgroundColor: colors.print,
                  paddingHorizontal: space.sm,
                  paddingVertical: space.xxs,
                  transform: [{ rotate: "-4deg" }],
                }}
              >
                <Text variant="stamp" color="stampText" style={{ fontSize: 10 }}>
                  Given
                </Text>
              </View>
            ) : null}
          </View>
          <View style={{ paddingTop: space.md, paddingHorizontal: space.xs, gap: space.xxs }}>
            <Text variant="storyExcerpt" color="textSecondary" numberOfLines={2} hangingPunctuation>
              “{storyExcerpt(listing.story)}”
            </Text>
            <Text variant="title" numberOfLines={1}>
              {listing.title}
            </Text>
            <Text variant="caption" color="textTertiary" style={{ textTransform: "lowercase" }}>
              {caption(listing)}
            </Text>
          </View>
        </Print>
      </Pressable>
    </Link>
  );
}

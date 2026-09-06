// Dashboard: every listing this device's owner token has ever created,
// grouped into Reviewing / Live / Needs attention / Given / Withdrawn.
import * as React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Link, useLocalSearchParams, useRouter } from "expo-router";
import { Image as ExpoImage } from "expo-image";
import { sectionRhythm, space } from "@keepsake/tokens/spacing";
import { radii } from "@keepsake/tokens/radii";
import { MODERATION_REASONS, type ListingStatus, type OwnerListing } from "@keepsake/contracts/listing";
import { ReadableWidth } from "@/ui/ReadableWidth";
import { EmptyState } from "@/ui/EmptyState";
import { Eyebrow } from "@/ui/Eyebrow";
import { Button } from "@/ui/Button";
import { TagCard } from "@/ui/TagCard";
import { DeckleRule } from "@/ui/DeckleRule";
import { Text, type TextColor } from "@/ui/Text";
import { Skeleton } from "@/ui/Skeleton";
import { Seal } from "@/ui/Seal";
import { useColors } from "@/ui/theme";
import { useToast } from "@/ui/Toast";
import { getOwnerToken } from "@/lib/ownerToken";
import { getMyListings } from "@/api/me";
import { ApiError } from "@/api/client";
import { LISTING_GROUP_LABELS, LISTING_GROUP_ORDER, groupListings } from "@/features/mine/groupListings";

/** The `/mine?verified=1|0&reason=` toast the email-verify link redirects
 * to. A dedicated hook (rather than inlining in the component body) so it's
 * easy to see this only ever fires once per verify redirect: the params are
 * cleared via `router.setParams` right after the toast, so a later re-render
 * of this screen (e.g. tab refocus) never re-shows it. */
function useVerifiedToast(): void {
  const router = useRouter();
  const toast = useToast();
  const params = useLocalSearchParams<{ verified?: string; reason?: string }>();
  const handled = React.useRef(false);

  React.useEffect(() => {
    if (handled.current || params.verified === undefined) return;
    handled.current = true;
    if (params.verified === "1") {
      toast.show("Email verified.");
    } else {
      toast.show(params.reason !== undefined ? `Couldn't verify: ${params.reason}` : "Couldn't verify that email.");
    }
    router.setParams({ verified: undefined, reason: undefined } as never);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.verified, params.reason]);
}

/** Status as a small serif label on the row, not a chip: green for live,
 * foil for anything still in the box, ink-red only when it needs a hand. */
const STATUS_LABELS: Record<ListingStatus, { label: string; color: TextColor }> = {
  pending: { label: "Reviewing", color: "foilText" },
  needs_review: { label: "Held", color: "foilText" },
  approved: { label: "Live", color: "accent2Text" },
  rejected: { label: "Needs attention", color: "dangerText" },
  given: { label: "Given", color: "foilText" },
  withdrawn: { label: "Withdrawn", color: "foilText" },
  hidden: { label: "Hidden", color: "dangerText" },
};

function ListingRow({ listing, index }: { listing: OwnerListing; index: number }): React.ReactElement {
  const colors = useColors();
  const cover = listing.photos[0];
  const canShowFull = listing.status === "approved" || listing.status === "given";
  const status = STATUS_LABELS[listing.status];

  return (
    <Link href={{ pathname: "/mine/[id]", params: { id: listing.id } }} asChild>
      <Pressable accessibilityRole="button" accessibilityLabel={`Open ${listing.title}`}>
        <TagCard interactive tilt={index % 2 === 0 ? 1 : -1} style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.md, paddingRight: space.lg, paddingLeft: space.xxxl }}>
          <View style={{ width: 64, height: 64, borderRadius: radii.sm, overflow: "hidden", backgroundColor: colors.surfaceSunken }}>
            <ExpoImage
              source={canShowFull && cover !== undefined ? `/i/${cover.id}/thumb` : null}
              placeholder={cover !== undefined ? { blurhash: cover.blurhash } : null}
              style={{ width: "100%", height: "100%" }}
              contentFit="cover"
              accessibilityLabel=""
            />
          </View>
          <View style={{ flex: 1, gap: space.xxs }}>
            <Text variant="title" numberOfLines={1}>
              {listing.title}
            </Text>
            <Text variant="storyExcerpt" color="textSecondary" numberOfLines={1} hangingPunctuation>
              “{listing.story}”
            </Text>
            {listing.status === "rejected" && listing.moderation_reason !== null ? (
              <Text variant="caption" color="dangerText">
                {MODERATION_REASONS[listing.moderation_reason]}
              </Text>
            ) : null}
          </View>
          <Text variant="eyebrow" color={status.color} style={{ fontSize: 11, lineHeight: 14 }}>
            {status.label}
          </Text>
        </TagCard>
      </Pressable>
    </Link>
  );
}

export default function Mine(): React.ReactElement {
  const colors = useColors();
  useVerifiedToast();
  const [hasOwnerToken] = React.useState(() => getOwnerToken() !== null);
  const [listings, setListings] = React.useState<OwnerListing[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!hasOwnerToken) return;
    let cancelled = false;
    getMyListings()
      .then((result) => {
        if (!cancelled) setListings(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "Couldn't load your listings.");
      });
    return () => {
      cancelled = true;
    };
  }, [hasOwnerToken]);

  if (!hasOwnerToken) {
    return (
      <ReadableWidth variant="prose" style={{ paddingVertical: sectionRhythm.normal }}>
        <EmptyState
          ornament={<Seal state="idle" />}
          eyebrow="Mine"
          title="You haven't given anything yet."
          line="Once you give something, it'll show up here so you can follow along."
          action={
            <View style={{ gap: space.lg, alignItems: "center" }}>
              <Link href="/give" asChild>
                <Button label="Give something" />
              </Link>
              <Link href="/recover" asChild>
                <Button label="Lost your listings?" variant="link" />
              </Link>
            </View>
          }
        />
      </ReadableWidth>
    );
  }

  if (error !== null) {
    return (
      <ReadableWidth variant="prose" style={{ paddingVertical: sectionRhythm.normal }}>
        <EmptyState eyebrow="Mine" title="Couldn't load your listings" line={error} />
      </ReadableWidth>
    );
  }

  if (listings === null) {
    return (
      <ReadableWidth variant="prose" style={{ paddingVertical: sectionRhythm.normal, gap: space.md }}>
        <Skeleton height={88} style={{ borderRadius: radii.tag }} />
        <Skeleton height={88} style={{ borderRadius: radii.tag }} />
        <Skeleton height={88} style={{ borderRadius: radii.tag }} />
      </ReadableWidth>
    );
  }

  if (listings.length === 0) {
    return (
      <ReadableWidth variant="prose" style={{ paddingVertical: sectionRhythm.normal }}>
        <EmptyState
          ornament={<Seal state="idle" />}
          eyebrow="Mine"
          title="You haven't given anything yet."
          line="Once you give something, it'll show up here so you can follow along."
          action={
            <Link href="/give" asChild>
              <Button label="Give something" />
            </Link>
          }
        />
      </ReadableWidth>
    );
  }

  const groups = groupListings(listings);

  return (
    <ReadableWidth variant="prose" style={{ paddingVertical: sectionRhythm.normal }}>
      <View style={{ flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", flexWrap: "wrap", gap: space.md }}>
        <View style={{ gap: space.sm }}>
          <Eyebrow tick>Your keepsakes</Eyebrow>
          <Text variant="displayLg">Mine</Text>
        </View>
        <Link href="/mine/email" asChild>
          <Button label="Email" variant="link" arrow={false} />
        </Link>
      </View>
      <DeckleRule style={{ marginTop: sectionRhythm.tight, marginBottom: sectionRhythm.tight }} />
      <View style={{ gap: sectionRhythm.normal }}>
        {LISTING_GROUP_ORDER.map((key) => {
          const group = groups[key];
          if (group.length === 0) return null;
          return (
            <View key={key} style={{ gap: space.lg }}>
              <View style={{ paddingBottom: space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.rule }}>
                <Eyebrow>{LISTING_GROUP_LABELS[key]}</Eyebrow>
              </View>
              <View style={{ gap: space.lg }}>
                {group.map((listing, index) => (
                  <ListingRow key={listing.id} listing={listing} index={index} />
                ))}
              </View>
            </View>
          );
        })}
      </View>
    </ReadableWidth>
  );
}

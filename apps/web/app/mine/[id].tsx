// Dashboard detail: photos, story, status/moderation copy, and the owner
// actions (Edit, Mark given, Withdraw/Relist, Delete). Requests are M3 —
// this always shows the "share the link" empty state for now.
import * as React from "react";
import { StyleSheet, View } from "react-native";
import { Link, useLocalSearchParams, useRouter } from "expo-router";
import { Image as ExpoImage } from "expo-image";
import { sectionRhythm, space } from "@keepsake/tokens/spacing";
import { radii } from "@keepsake/tokens/radii";
import { MODERATION_REASONS, type ListingStatus } from "@keepsake/contracts/listing";
import { ReadableWidth } from "@/ui/ReadableWidth";
import { Text, type TextColor } from "@/ui/Text";
import { Eyebrow } from "@/ui/Eyebrow";
import { Button } from "@/ui/Button";
import { TagCard } from "@/ui/TagCard";
import { Sheet } from "@/ui/Sheet";
import { Skeleton } from "@/ui/Skeleton";
import { EmptyState } from "@/ui/EmptyState";
import { useColors } from "@/ui/theme";
import { getMyListing, type OwnerListingDetail } from "@/api/me";
import { deleteListing, markGiven, relistListing, withdrawListing } from "@/api/listings";
import { ApiError } from "@/api/client";

const STATUS_LABELS: Record<ListingStatus, { label: string; color: TextColor }> = {
  pending: { label: "Reviewing", color: "foilText" },
  needs_review: { label: "Taking a closer look", color: "foilText" },
  approved: { label: "Live", color: "accent2Text" },
  rejected: { label: "Needs attention", color: "dangerText" },
  given: { label: "Given", color: "foilText" },
  withdrawn: { label: "Withdrawn", color: "foilText" },
  hidden: { label: "Hidden", color: "dangerText" },
};

const THUMB = 120;

export default function MineDetail(): React.ReactElement {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const colors = useColors();
  const [listing, setListing] = React.useState<OwnerListingDetail | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  const load = React.useCallback(() => {
    if (typeof id !== "string") return;
    getMyListing(id)
      .then((detail) => setListing(detail))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Couldn't load this listing."));
  }, [id]);

  React.useEffect(() => {
    load();
  }, [load]);

  async function runAction(action: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    try {
      await action();
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't go through. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function handleDelete(): void {
    setConfirmDelete(false);
    if (listing === null) return;
    void runAction(() => deleteListing(listing.id)).then(() => router.replace("/mine"));
  }

  if (error !== null && listing === null) {
    return (
      <ReadableWidth variant="prose" style={{ paddingVertical: sectionRhythm.normal }}>
        <EmptyState eyebrow="Mine" title="Couldn't load this listing" line={error} />
      </ReadableWidth>
    );
  }

  if (listing === null) {
    return (
      <ReadableWidth variant="prose" style={{ paddingVertical: sectionRhythm.normal, gap: space.md }}>
        <Skeleton height={200} style={{ borderRadius: radii.tag }} />
        <Skeleton height={80} style={{ borderRadius: radii.tag }} />
      </ReadableWidth>
    );
  }

  const canShowFull = listing.status === "approved" || listing.status === "given";
  const status = STATUS_LABELS[listing.status];
  const rule = { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.rule, paddingBottom: space.sm };

  return (
    <ReadableWidth variant="prose" style={{ paddingVertical: sectionRhythm.normal, gap: space.xl }}>
      {/* Photos as small tags, alternating lean. */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg, paddingTop: space.sm }}>
        {listing.photos.map((photo, index) => (
          <TagCard key={photo.id} tilt={index % 2 === 0 ? 1 : -1} style={{ width: THUMB, height: THUMB }}>
            <View
              style={{
                width: "100%",
                height: "100%",
                overflow: "hidden",
                borderTopRightRadius: radii.tag,
                borderBottomRightRadius: radii.tag,
                borderBottomLeftRadius: radii.tag,
                backgroundColor: colors.surfaceSunken,
              }}
            >
              <ExpoImage
                source={canShowFull ? `/i/${photo.id}/thumb` : null}
                placeholder={{ blurhash: photo.blurhash }}
                style={{ width: "100%", height: "100%" }}
                contentFit="cover"
                accessibilityLabel=""
              />
            </View>
          </TagCard>
        ))}
      </View>

      <View style={{ gap: space.sm }}>
        <Eyebrow color={status.color}>{status.label}</Eyebrow>
        <Text variant="displayLg">{listing.title}</Text>
        <Text variant="bodyLg" color="inkSoft">
          {listing.story}
        </Text>
      </View>

      <View style={{ gap: space.sm }}>
        <View style={rule}>
          <Eyebrow>Status</Eyebrow>
        </View>
        <Text variant="title">{status.label}</Text>
        {listing.status === "rejected" && listing.moderation_reason !== null ? (
          <Text variant="body" color="dangerText">
            {MODERATION_REASONS[listing.moderation_reason]}
          </Text>
        ) : null}
        {listing.status === "needs_review" ? (
          <Text variant="body" color="textSecondary">
            Taking a closer look. Usually within a day.
          </Text>
        ) : null}
        {error !== null ? (
          <Text variant="body" color="dangerText">
            {error}
          </Text>
        ) : null}
      </View>

      <View style={{ gap: space.sm }}>
        <View style={rule}>
          <Eyebrow>Requests</Eyebrow>
        </View>
        <Text variant="body" color="textSecondary">
          No one has asked yet. Share the link.
        </Text>
      </View>

      {/* One pill at most; the rest are bordered, the destructive one bare. */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.md }}>
        {listing.status === "approved" ? (
          <Button label="Mark given" disabled={busy} onPress={() => runAction(() => markGiven(listing.id))} />
        ) : null}
        {listing.status === "withdrawn" ? (
          <Button label="Relist" disabled={busy} onPress={() => runAction(() => relistListing(listing.id))} />
        ) : null}
        <Link href={{ pathname: "/give", params: { edit: listing.id } }} asChild>
          <Button label="Edit" variant="secondary" disabled={busy} />
        </Link>
        {listing.status !== "withdrawn" && listing.status !== "given" ? (
          <Button label="Withdraw" variant="secondary" disabled={busy} onPress={() => runAction(() => withdrawListing(listing.id))} />
        ) : null}
        <Button label="Delete" variant="ghost" disabled={busy} onPress={() => setConfirmDelete(true)} />
      </View>

      <Sheet visible={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this listing?">
        <Text variant="body" color="textSecondary">
          {"This can't be undone."}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xl, marginTop: space.md }}>
          <Button label="Delete" variant="primary" onPress={handleDelete} />
          <Button label="Cancel" variant="link" arrow={false} onPress={() => setConfirmDelete(false)} />
        </View>
      </Sheet>
    </ReadableWidth>
  );
}

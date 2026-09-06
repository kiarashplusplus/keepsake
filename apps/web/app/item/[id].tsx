// Item detail: photo carousel, the story as prose, meta line, and the three
// visitor actions (request / share / report). `GET /api/listings/:id` only
// ever returns `approved`/`given` listings — anything else 404s, which this
// renders as the same not-found state as `app/+not-found.tsx`.
import * as React from "react";
import { useWindowDimensions, View } from "react-native";
import { Link, useLocalSearchParams } from "expo-router";
import { CATEGORY_LABELS } from "@keepsake/contracts/listing";
import { sectionRhythm, space } from "@keepsake/tokens/spacing";
import { radii } from "@keepsake/tokens/radii";
import { ReadableWidth } from "@/ui/ReadableWidth";
import { Text } from "@/ui/Text";
import { Eyebrow } from "@/ui/Eyebrow";
import { Button } from "@/ui/Button";
import { DeckleRule } from "@/ui/DeckleRule";
import { Skeleton } from "@/ui/Skeleton";
import { EmptyState } from "@/ui/EmptyState";
import { Seal } from "@/ui/Seal";
import { useColors } from "@/ui/theme";
import { useToast } from "@/ui/Toast";
import { PhotoCarousel } from "@/features/item/PhotoCarousel";
import { RequestSheet } from "@/features/request/RequestSheet";
import { ReportSheet } from "@/features/report/ReportSheet";
import { getListing } from "@/api/listings";
import { ApiError } from "@/api/client";
import { shareListing } from "@/lib/share";
import { relativeTime } from "@/lib/relativeTime";
import { track } from "@/lib/analytics";
import { AnalyticsEvents } from "@/lib/analyticsEvents";
import type { PublicListing } from "@keepsake/contracts/listing";

const WIDE_TITLE_BREAKPOINT = 820;

function metaLine(listing: PublicListing): string {
  const place = listing.admin1 !== null ? `${listing.place_name}, ${listing.admin1}` : listing.place_name;
  return `${CATEGORY_LABELS[listing.category]} · ${place} · posted ${relativeTime(listing.published_at)}`;
}

export default function Item(): React.ReactElement {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useColors();
  const toast = useToast();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_TITLE_BREAKPOINT;
  const [listing, setListing] = React.useState<PublicListing | null>(null);
  const [notFound, setNotFound] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [requestOpen, setRequestOpen] = React.useState(false);
  const [reportOpen, setReportOpen] = React.useState(false);

  React.useEffect(() => {
    if (typeof id !== "string") return undefined;
    let cancelled = false;

    getListing(id)
      .then((result) => {
        if (cancelled) return;
        setListing(result);
        setNotFound(false);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.code === "not_found") {
          setNotFound(true);
          return;
        }
        setError(err instanceof ApiError ? err.message : "Couldn't load this keepsake.");
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  React.useEffect(() => {
    if (listing === null || typeof document === "undefined") return;
    document.title = `${listing.title} · Keepsake`;
    track(AnalyticsEvents.ItemViewed, { id: listing.id });
  }, [listing]);

  async function handleShare(): Promise<void> {
    if (listing === null) return;
    const result = await shareListing({ id: listing.id, title: listing.title });
    if (result === "copied") toast.show("Link copied.");
    if (result === "failed") toast.show("Couldn't share — try copying the link from the address bar.");
  }

  if (notFound) {
    return (
      <ReadableWidth variant="prose" style={{ paddingVertical: sectionRhythm.normal }}>
        <EmptyState
          ornament={<Seal state="idle" />}
          eyebrow="Not found"
          title="That keepsake isn’t here"
          line="It may have already found a home, or the link might be off."
          action={
            <Link href="/" asChild>
              <Button label="Back to the feed" />
            </Link>
          }
        />
      </ReadableWidth>
    );
  }

  if (error !== null) {
    return (
      <ReadableWidth variant="prose" style={{ paddingVertical: sectionRhythm.normal }}>
        <EmptyState eyebrow="Keepsake" title="Couldn't load this keepsake" line={error} />
      </ReadableWidth>
    );
  }

  if (listing === null) {
    return (
      <ReadableWidth variant="prose" style={{ paddingVertical: sectionRhythm.normal, gap: space.lg }}>
        <Skeleton height={320} style={{ borderRadius: radii.lg }} />
        <Skeleton height={40} width="70%" />
        <Skeleton height={100} />
      </ReadableWidth>
    );
  }

  const given = listing.status === "given";

  return (
    <ReadableWidth variant="prose" style={{ paddingVertical: sectionRhythm.normal, gap: space.xl }}>
      <PhotoCarousel photos={listing.photos} />

      {given ? (
        <View style={{ alignSelf: "flex-start", backgroundColor: colors.foil, borderRadius: radii.sm, paddingHorizontal: space.md, paddingVertical: space.xs }}>
          <Text variant="eyebrow" color="onFoil">
            Given
          </Text>
        </View>
      ) : null}

      <View style={{ gap: space.sm }}>
        <Eyebrow>{CATEGORY_LABELS[listing.category]}</Eyebrow>
        <Text variant={wide ? "displayXl" : "displayLg"}>{listing.title}</Text>
      </View>

      <DeckleRule />

      <Text variant="bodyLg" color="inkSoft">
        {listing.story}
      </Text>

      <Text variant="caption" color="textTertiary">
        {metaLine(listing)}
      </Text>

      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xl }}>
        {!given ? <Button label="I'd love this" onPress={() => setRequestOpen(true)} /> : null}
        <Button label="Share" variant="link" onPress={() => void handleShare()} />
        <Button label="Report" variant="ghost" onPress={() => setReportOpen(true)} />
      </View>

      <RequestSheet visible={requestOpen} onClose={() => setRequestOpen(false)} listingId={listing.id} />
      <ReportSheet visible={reportOpen} onClose={() => setReportOpen(false)} listingId={listing.id} />
    </ReadableWidth>
  );
}

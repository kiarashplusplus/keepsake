// Item detail: photo carousel, the story as prose, meta line, and the three
// visitor actions (request / share / report). `GET /api/listings/:id` only
// ever returns `approved`/`given` listings — anything else 404s, which this
// renders as the same not-found state as `app/+not-found.tsx`.
//
// At desktop widths the print and the story sit side by side rather than
// stacked (#222) — see `TWO_COLUMN_BREAKPOINT` below for why, and why it is
// not the same number as the title's breakpoint.
import * as React from "react";
import { useWindowDimensions, View } from "react-native";
import { Link, useLocalSearchParams } from "expo-router";
import { CATEGORY_LABELS } from "@keepsake/contracts/listing";
import { sectionRhythm, space } from "@keepsake/tokens/spacing";
import { Page } from "@/ui/Page";
import { Text } from "@/ui/Text";
import { Eyebrow } from "@/ui/Eyebrow";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Surface";
import { PencilRule } from "@/ui/PencilRule";
import { Skeleton } from "@/ui/Skeleton";
import { EmptyState } from "@/ui/EmptyState";
import { Stamp } from "@/ui/Stamp";
import { useColors } from "@/ui/theme";
import { useToast } from "@/ui/Toast";
import { PhotoCarousel } from "@/features/item/PhotoCarousel";
import { AspectList } from "@/features/item/AspectList";
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

/**
 * Where the page stops being one column and becomes print-left / story-right
 * (#222). At 1280×800 the stacked layout spent the entire viewport height on
 * the photograph: the title was cut by the fold and the story was well below
 * it, so on a page whose whole proposition is *a photograph and the story
 * attached to it* you could not see both at once.
 *
 * Deliberately NOT `WIDE_TITLE_BREAKPOINT`. That one only picks a type size,
 * so it can afford to fire early; this one moves the whole page and has to
 * earn its width. At 820 the `grid` measure is the viewport itself, so after
 * the page's 16px gutters and the 32px column gap each column would land
 * around 378px — the phone column, twice — which is a worse page than the
 * single column it replaced, not a better one. 1024 is the first width where
 * the split is worth taking: the print column clears ~436px and the story
 * ~524px, a print big enough to actually read the photograph off and a
 * measure long enough that the story doesn't go ragged. It is also the
 * conventional landscape-tablet / small-laptop width, so the change lands on
 * the class of screen the issue is about, and the 1280×800 frame it opens
 * with sits well clear of it.
 *
 * Below this the page is byte-for-byte the layout it has always been. Most
 * visits are narrow and the issue says that layout is fine; this is additive.
 */
const TWO_COLUMN_BREAKPOINT = 1024;

/**
 * The 5:6 split, as flex parts. The story is given the larger share on
 * purpose — it is the product (`AGENTS.md`: "the product is the story"), it
 * is the taller of the two boxes, and prose punishes a short measure far more
 * than a 4:3 print punishes a hundred missing pixels.
 */
const PRINT_COLUMN_PARTS = 5;
const STORY_COLUMN_PARTS = 6;

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
  const twoColumn = width >= TWO_COLUMN_BREAKPOINT;
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

  // The three branches below stay on the 720px prose measure at every width,
  // including desktop. There is no second column to put anything in: an empty
  // state or a pair of skeletons stretched across 1100px would be a wider
  // nothing, not a fuller page. #222 is about a screen with two things on it.
  if (notFound) {
    return (
      <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal }}>
        <EmptyState
          ornament={<Stamp state="idle" label="Not found" />}
          eyebrow="Not found"
          title="That keepsake isn’t here"
          line="It may have already found a home, or the link might be off."
          action={
            <Link href="/" asChild>
              <Button label="Back to the feed" />
            </Link>
          }
        />
      </Page>
    );
  }

  if (error !== null) {
    return (
      <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal }}>
        <EmptyState eyebrow="Keepsake" title="Couldn't load this keepsake" line={error} />
      </Page>
    );
  }

  if (listing === null) {
    return (
      <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal, gap: space.lg }}>
        <Skeleton height={320} />
        <Card style={{ gap: space.md }}>
          <Skeleton height={40} width="70%" />
          <Skeleton height={100} />
        </Card>
      </Page>
    );
  }

  const given = listing.status === "given";

  // Print and story are built once and *placed* twice. The two layouts differ
  // only in where these two blocks sit relative to each other, so writing the
  // content out twice would be two copies free to drift — and the `Given`
  // stamp, the `PencilRule`, the aspects and the three actions all have to be
  // identical in both.
  const printBlock = (
    <>
      {/* In the left column the column is the width constraint, so the
          carousel's own 560px cap is dropped — see `PhotoCarouselProps`. */}
      <PhotoCarousel photos={listing.photos} maxWidth={twoColumn ? null : undefined} />

      {/* The stamp travels with the print, not with the story card — it is a
          fact about the object, and it should be the next thing your eye
          meets after the photograph. So it stays directly under the print in
          both layouts: under it on the page when stacked, under it inside the
          left column when split. */}
      {given ? (
        <View
          style={{
            alignSelf: "flex-start",
            borderWidth: 2,
            borderColor: colors.accent,
            paddingHorizontal: space.md,
            paddingVertical: space.xs,
            transform: [{ rotate: "-3deg" }],
          }}
        >
          <Text variant="stamp" color="stampText">
            Given
          </Text>
        </View>
      ) : null}
    </>
  );

  // The story lives on an index card — a display case, not a bare page of text
  // on the table. Below the print when stacked, beside it when split.
  const storyBlock = (
    <Card style={{ gap: space.lg }}>
      <View style={{ gap: space.sm }}>
        <Eyebrow>{CATEGORY_LABELS[listing.category]}</Eyebrow>
        <Text variant={wide ? "displayXl" : "displayLg"}>{listing.title}</Text>
      </View>

      <PencilRule />

      <Text variant="bodyLg" color="inkSoft">
        {listing.story}
      </Text>

      {/* Below the story, never above it: the story is the product, and
          what the model read off the photo is an annotation on it (#135).
          Renders nothing when the listing has no aspects. */}
      <AspectList aspects={listing.aspects} />

      <Text variant="caption" color="textTertiary" style={{ textTransform: "lowercase" }}>
        {metaLine(listing)}
      </Text>

      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xl }}>
        {!given ? <Button label="I'd love this" onPress={() => setRequestOpen(true)} /> : null}
        <Button label="Share" variant="link" onPress={() => void handleShare()} />
        <Button label="Report" variant="ghost" onPress={() => setReportOpen(true)} />
      </View>
    </Card>
  );

  return (
    <Page
      variant={twoColumn ? "grid" : "prose"}
      contentContainerStyle={{ paddingVertical: sectionRhythm.normal, gap: space.xl }}
    >
      {twoColumn ? (
        // `alignItems: "flex-start"` so the print keeps its 4:3 box instead of
        // being stretched to the height of a long story, which is the whole
        // reason the story is on the other side of it.
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.xxl }}>
          <View style={{ flex: PRINT_COLUMN_PARTS, gap: space.xl }}>{printBlock}</View>
          <View style={{ flex: STORY_COLUMN_PARTS }}>{storyBlock}</View>
        </View>
      ) : (
        // Stacked: the fragments flatten into the page's own children, so the
        // `gap: space.xl` above is the spacing between print, stamp and card
        // exactly as it was before the split existed.
        <>
          {printBlock}
          {storyBlock}
        </>
      )}

      <RequestSheet visible={requestOpen} onClose={() => setRequestOpen(false)} listingId={listing.id} />
      <ReportSheet visible={reportOpen} onClose={() => setReportOpen(false)} listingId={listing.id} />
    </Page>
  );
}

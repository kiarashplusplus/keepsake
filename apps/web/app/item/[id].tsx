// Item detail: photo carousel, the story as prose, meta line, and the three
// visitor actions (request / share / report). `GET /api/listings/:id` only
// ever returns `approved`/`given` listings — anything else 404s, which this
// renders as the same not-found state as `app/+not-found.tsx`.
//
// A `given` listing is a live page, not an error page: it is what a stranger
// reaches from an old link or a card that unfurled in a group chat. So it
// keeps the photograph and the story and changes three things (#359) — it
// says "This one has found a home." in words, it swaps the request button for
// a link onward to the feed rather than promoting Share into that slot, and
// its meta line dates the giving instead of the posting.
//
// At desktop widths the print and the story sit side by side rather than
// stacked (#222) — see `breakpoint.detailTwoColumn` in
// `packages/tokens/src/breakpoints.ts` for why, and why it is not the same
// number as `WIDE_TITLE_BREAKPOINT` below. `mine/[id].tsx`, the giver's own
// copy of this page, imports the same constant for the same split.
import * as React from "react";
import { useWindowDimensions, View } from "react-native";
import { Link, useLocalSearchParams } from "expo-router";
import { CATEGORY_LABELS } from "@keepsake/contracts/listing";
import { breakpoint } from "@keepsake/tokens/breakpoints";
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
import { readInlineListing } from "@/features/item/inlineListing";
import { ApiError } from "@/api/client";
import { shareListing } from "@/lib/share";
import { relativeTime } from "@/lib/relativeTime";
import { track } from "@/lib/analytics";
import { AnalyticsEvents } from "@/lib/analyticsEvents";
import type { PublicListing } from "@keepsake/contracts/listing";

const WIDE_TITLE_BREAKPOINT = 820;

/**
 * The 5:6 split, as flex parts. The story is given the larger share on
 * purpose — it is the product (`AGENTS.md`: "the product is the story"), it
 * is the taller of the two boxes, and prose punishes a short measure far more
 * than a 4:3 print punishes a hundred missing pixels.
 */
const PRINT_COLUMN_PARTS = 5;
const STORY_COLUMN_PARTS = 6;

/**
 * The last clause of the meta line. A given keepsake dating itself "posted 1
 * min ago" was #359's smallest tell: the freshest-sounding thing on the page
 * was the one fact that had stopped being true. `given_at` is optional on
 * `PublicListing` — `serialize.ts` omits the key when the column is null, so
 * a row marked given before that column was written still falls back to the
 * publish date rather than rendering "given undefined".
 */
function whenLine(listing: PublicListing): string {
  if (listing.status === "given" && listing.given_at !== undefined) return `given ${relativeTime(listing.given_at)}`;
  return `posted ${relativeTime(listing.published_at)}`;
}

function metaLine(listing: PublicListing): string {
  const place = listing.admin1 !== null ? `${listing.place_name}, ${listing.admin1}` : listing.place_name;
  return `${CATEGORY_LABELS[listing.category]} · ${place} · ${whenLine(listing)}`;
}

export default function Item(): React.ReactElement {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useColors();
  const toast = useToast();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_TITLE_BREAKPOINT;
  const twoColumn = width >= breakpoint.detailTwoColumn;
  const [listing, setListing] = React.useState<PublicListing | null>(null);
  const [notFound, setNotFound] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [requestOpen, setRequestOpen] = React.useState(false);
  const [reportOpen, setReportOpen] = React.useState(false);

  React.useEffect(() => {
    if (typeof id !== "string") return undefined;

    const controller = new AbortController();

    // The Worker that served this page already had the row — it needed it
    // for the share card's tags — and wrote it into the HTML. When that is
    // this keepsake, there is nothing to fetch: the round trip the app used
    // to make here was asking the server for something it had already sent.
    // Every other entry into this screen (a tap through from the feed, a
    // second keepsake in the same session) finds no payload and falls
    // through to the request, unchanged.
    //
    // Both sources land in the same `.then` on purpose. It keeps one code
    // path — one place that decides what "loaded", "not found" and "failed"
    // mean — and it keeps the state update out of the effect body, where it
    // would be a synchronous render cascade (and where the server render, of
    // course, has no DOM to read).
    const inlined = readInlineListing(id);
    const load = inlined !== null ? Promise.resolve(inlined) : getListing(id, controller.signal);

    load
      .then((result) => {
        if (controller.signal.aborted) return;
        setListing(result);
        setNotFound(false);
        setError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.code === "not_found") {
          setNotFound(true);
          return;
        }
        setError(err instanceof ApiError ? err.message : "Couldn't load this keepsake.");
      });

    return () => {
      // Leaving the screen mid-request (a back tap, or straight on to
      // another keepsake) now cancels it rather than letting it finish into
      // a component nobody is looking at.
      controller.abort();
    };
  }, [id]);

  React.useEffect(() => {
    if (listing === null || typeof document === "undefined") return;
    document.title = `${listing.title} · Keepsake`;
    track(AnalyticsEvents.ItemViewed, { id: listing.id });
  }, [listing]);

  async function handleShare(): Promise<void> {
    if (listing === null) return;
    const result = await shareListing({ id: listing.id, title: listing.title, surface: "item" });
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
        {/* The stamp says it in ink; this says it in words, and it says it
            here — in the story column, under the title — because at desktop
            widths the stamp is in the *other* column, and a visitor who
            never looks left has otherwise been told nothing (#359). The
            story below is still written in the present tense by whoever
            posted it, so the page needs one sentence of its own that isn't. */}
        {given ? (
          <Text variant="bodyLg" color="textSecondary">
            This one has found a home.
          </Text>
        ) : null}
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

      {/* Exactly one underlined action, whatever the status. While the
          keepsake is live that is Share, sitting after the red "I'd love
          this"; once it is given, removing the request button used to
          *promote* Share — so the first and loudest thing offered to a
          stranger who arrived from an old link was to pass on a link to
          something nobody can have (#359). The onward link takes that rank
          instead, and Share drops to a ghost beside Report: still there for
          anyone who wants to show someone the story, no longer the
          suggestion the page leads with. */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.xl }}>
        {given ? (
          <Link href="/" asChild>
            <Button label="See what else is nearby" variant="link" />
          </Link>
        ) : (
          <Button label="I'd love this" onPress={() => setRequestOpen(true)} />
        )}
        <Button label="Share" variant={given ? "ghost" : "link"} onPress={() => void handleShare()} />
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

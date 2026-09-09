// Dashboard detail: photos, story, what this listing needs from its giver,
// status/moderation copy, its requests, and the owner actions (Edit, Mark
// given, Withdraw/Relist, Delete).
//
// At desktop widths the photos sit in their own column beside everything
// else, the same treatment `app/item/[id].tsx` gives the public item page
// (#222) — issue #373 finding 7 caught this page never having received it:
// at 1280x800 the 120px thumbnail band sat alone across the full measure
// with one column of text underneath, while the same keepsake's public page
// a click away already split print-left/story-right. See
// `TWO_COLUMN_BREAKPOINT` below for why this page keeps its own copy of that
// constant rather than importing one.
import * as React from "react";
import { useWindowDimensions, View } from "react-native";
import { Link, useLocalSearchParams, useRouter } from "expo-router";
import { Image as ExpoImage } from "expo-image";
import { motion } from "@keepsake/tokens/motion";
import { sectionRhythm, space } from "@keepsake/tokens/spacing";
import { MODERATION_REASONS, type ListingStatus } from "@keepsake/contracts/listing";
import { Page } from "@/ui/Page";
import { Text, type TextColor } from "@/ui/Text";
import { Eyebrow } from "@/ui/Eyebrow";
import { Button } from "@/ui/Button";
import { Print } from "@/ui/Print";
import { Card } from "@/ui/Surface";
import { Sheet } from "@/ui/Sheet";
import { Skeleton } from "@/ui/Skeleton";
import { EmptyState } from "@/ui/EmptyState";
import { useColors } from "@/ui/theme";
import { tiltDegForId } from "@/lib/masonry";
import { chooseRequest, getMyListing, type OwnerListingDetail } from "@/api/me";
import { deleteListing, markGiven, relistListing, setListingCategory, withdrawListing } from "@/api/listings";
import { ApiError } from "@/api/client";
import { CategorySection } from "@/features/mine/CategorySection";
import { StaleNotice } from "@/features/mine/StaleNotice";
import { RequestList } from "@/features/mine/RequestList";
import { HandoffSheet } from "@/features/mine/HandoffSheet";
import { track } from "@/lib/analytics";
import { AnalyticsEvents } from "@/lib/analyticsEvents";
import { RouteHead } from "@/ui/RouteHead";

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

/**
 * The 120px print at 1280x800 is what finding 7 named — a thumbnail that
 * size, alone in a full-width band, reads as an afterthought next to the
 * carousel the same keepsake gets on its public page. Bigger prints, in
 * their own column, is the same fix `item/[id].tsx` made by dropping the
 * carousel's 560px cap so the photograph fills its column instead of
 * whatever width a full-width band happened to leave it.
 */
const THUMB_WIDE = 168;

/**
 * Where this page stops stacking photos over the detail card and puts them
 * side by side instead. Deliberately the same number as `item/[id].tsx`'s
 * `TWO_COLUMN_BREAKPOINT` (#222) and for the same reason — that file's own
 * comment on the constant has the measurements; the two are not the same
 * import only because that file is owned by a different pull request in
 * this round of fixes. Move them together if either ever changes.
 */
const TWO_COLUMN_BREAKPOINT = 1024;

/**
 * Photos get the smaller share here, the opposite of `item/[id].tsx`'s
 * print/story split. There the print is one photograph the whole column
 * exists to show off; here it can be several thumbnails that only need
 * enough width to read as a row, while the right column carries the status
 * eyebrow, the story, moderation detail, the category picker, the full
 * requests list and every owner action — the page's actual business. Giving
 * that column the minority share, the way finding 7 was first drafted,
 * would have crushed the requests list into the same narrow gutter the
 * finding complained about, just relabelled.
 */
const PHOTOS_COLUMN_PARTS = 4;
const DETAILS_COLUMN_PARTS = 7;

// The one line the Status section exists for, or `null` when the eyebrow above
// the title has already said everything there is to say (issue #362). Only two
// statuses have more: a rejection has its moderator's reason, and a listing
// under a closer look has how long that usually takes.
function statusDetailFor(listing: OwnerListingDetail): { line: string; color: TextColor } | null {
  if (listing.status === "rejected" && listing.moderation_reason !== null) {
    return { line: MODERATION_REASONS[listing.moderation_reason], color: "dangerText" };
  }
  if (listing.status === "needs_review") {
    return { line: "Taking a closer look. Usually within a day.", color: "textSecondary" };
  }
  return null;
}

export default function MineDetail(): React.ReactElement {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const colors = useColors();
  const { width } = useWindowDimensions();
  const twoColumn = width >= TWO_COLUMN_BREAKPOINT;
  const [listing, setListing] = React.useState<OwnerListingDetail | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [chooseTarget, setChooseTarget] = React.useState<string | null>(null);
  const [choosing, setChoosing] = React.useState(false);
  const [chooseError, setChooseError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    if (typeof id !== "string") return;
    getMyListing(id)
      .then((detail) => setListing(detail))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "Couldn't load this listing."));
  }, [id]);

  React.useEffect(() => {
    load();
  }, [load]);

  // Resolves `true` only when the action actually went through. It still
  // swallows the error into `error` state — every caller but Delete stays on
  // this page and renders it — but a caller that *leaves* the page has to be
  // able to tell the two apart, because leaving is what destroys the error
  // (issue #172: a failed DELETE navigated to /mine anyway, so the giver was
  // shown a completed deletion for a listing that was still public).
  async function runAction(action: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    try {
      await action();
      load();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't go through. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(): Promise<void> {
    setConfirmDelete(false);
    if (listing === null) return;
    const deleted = await runAction(() => deleteListing(listing.id));
    // Only on success. On failure the giver stays here with the error line
    // above the buttons visible, and the listing they can still see is the
    // truth: it was not deleted.
    if (deleted) router.replace("/mine");
  }

  async function handleConfirmChoose(handoffNote: string): Promise<void> {
    if (listing === null || chooseTarget === null) return;
    setChoosing(true);
    setChooseError(null);
    try {
      await chooseRequest(listing.id, { request_id: chooseTarget, handoff_note: handoffNote });
      setChooseTarget(null);
      load();
      track(AnalyticsEvents.Chosen);
    } catch (err) {
      setChooseError(err instanceof ApiError ? err.message : "That didn't go through. Try again.");
    } finally {
      setChoosing(false);
    }
  }

  if (error !== null && listing === null) {
    return (
      <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal }}>
        <RouteHead title="Keepsake details" />
        <EmptyState eyebrow="Mine" title="Couldn't load this listing" line={error} />
      </Page>
    );
  }

  if (listing === null) {
    return (
      <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal, gap: space.md }}>
        <RouteHead title="Keepsake details" />
        <Skeleton height={200} />
        <Skeleton height={80} />
      </Page>
    );
  }

  const canShowFull = listing.status === "approved" || listing.status === "given";
  const status = STATUS_LABELS[listing.status];
  const statusDetail = statusDetailFor(listing);
  const rule = { borderBottomWidth: 2, borderBottomColor: colors.ink, paddingBottom: space.sm };
  const thumb = twoColumn ? THUMB_WIDE : THUMB;

  // Photos and the detail card are each built once and *placed* twice, the
  // same discipline `item/[id].tsx` uses for its print/story split: the
  // alternative is two copies free to drift, one for each layout.
  const photosBlock = (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg, paddingTop: space.sm }}>
      {listing.photos.map((photo) => (
        <Print key={photo.id} tiltDeg={tiltDegForId(photo.id, motion.tiltRangeDeg)} style={{ width: thumb, height: thumb, padding: 6 }}>
          <View
            style={{
              width: "100%",
              height: "100%",
              overflow: "hidden",
              backgroundColor: colors.tableEdge,
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
        </Print>
      ))}
    </View>
  );

  const detailBlock = (
    <Card style={{ gap: space.xl }}>
      <View style={{ gap: space.sm }}>
        <Eyebrow color={status.color}>{status.label}</Eyebrow>
        <Text variant="displayLg">{listing.title}</Text>
        <Text variant="bodyLg" color="inkSoft">
          {listing.story}
        </Text>
      </View>

      {/* Above Status, because it outranks it: "Live" is what moderation
          decided, and this is a person left waiting or a listing whose
          asks have nowhere to go. Both are invisible to the status label
          and both need the giver today. */}
      {listing.staleness.reasons.length > 0 ? (
        <View style={{ gap: space.sm }}>
          <View style={rule}>
            <Eyebrow color="dangerText">Needs you</Eyebrow>
          </View>
          <StaleNotice staleness={listing.staleness} />
        </View>
      ) : null}

      {/* Issue #362: the eyebrow above the title already says "Live" — a
          Status section whose whole content is the word "Live" again is a
          rule and a heading spent on nothing. It renders only when it has
          something the eyebrow cannot say: why a listing was rejected, or
          that a closer look is under way. On every other status the card
          gets shorter by one rule and the eyebrow carries it alone. */}
      {statusDetail !== null ? (
        <View style={{ gap: space.sm }}>
          <View style={rule}>
            <Eyebrow>Status</Eyebrow>
          </View>
          <Text variant="body" color={statusDetail.color}>
            {statusDetail.line}
          </Text>
        </View>
      ) : null}

      {/* Issue #155: the model decided this, and until now nobody could
          disagree with it. Sits above Requests because it is about the
          object rather than about who has asked for it. */}
      <CategorySection
        category={listing.category}
        categoryChosenAt={listing.category_chosen_at}
        editable={listing.status !== "given"}
        busy={busy}
        onChange={async (next) => {
          await runAction(() => setListingCategory(listing.id, next));
        }}
        rule={rule}
      />

      <View style={{ gap: space.sm }}>
        <View style={rule}>
          <Eyebrow>Requests</Eyebrow>
        </View>
        <RequestList
          requests={listing.requests}
          status={listing.status}
          canChoose={listing.chosen_request_id === null && listing.status === "approved"}
          busy={busy || choosing}
          onChoose={setChooseTarget}
        />
      </View>

      {/* An action error is about the button that was just pressed, not about
          what moderation decided, so it sits with the buttons — which is
          where `handleDelete`'s comment has always said it was. It used to
          render inside the Status section, with Category and Requests
          between it and the button that produced it. */}
      {error !== null ? (
        <Text variant="body" color="dangerText">
          {error}
        </Text>
      ) : null}

      {/* One stamp-red primary at most; the rest are ink-outlined, the destructive one bare. */}
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
    </Card>
  );

  return (
    <Page variant={twoColumn ? "grid" : "prose"} contentContainerStyle={{ paddingVertical: sectionRhythm.normal, gap: space.xl }}>
      <RouteHead title={listing.title} />
      {twoColumn ? (
        // `alignItems: "flex-start"` so the photos column keeps its own
        // height instead of being stretched to match the (usually much
        // taller) detail card beside it — the same reason `item/[id].tsx`
        // sets it on its print/story row.
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.xxl }}>
          <View style={{ flex: PHOTOS_COLUMN_PARTS }}>{photosBlock}</View>
          <View style={{ flex: DETAILS_COLUMN_PARTS }}>{detailBlock}</View>
        </View>
      ) : (
        // Stacked: unchanged from before the split — photos, then the card,
        // as siblings of the page's own children.
        <>
          {photosBlock}
          {detailBlock}
        </>
      )}

      <Sheet visible={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this listing?">
        <Text variant="body" color="textSecondary">
          {"This can't be undone."}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.xl, marginTop: space.md }}>
          <Button label="Delete" variant="primary" onPress={() => void handleDelete()} />
          <Button label="Cancel" variant="link" arrow={false} onPress={() => setConfirmDelete(false)} />
        </View>
      </Sheet>

      <HandoffSheet
        visible={chooseTarget !== null}
        onClose={() => {
          setChooseTarget(null);
          setChooseError(null);
        }}
        onConfirm={(handoffNote) => void handleConfirmChoose(handoffNote)}
        busy={choosing}
        error={chooseError}
        request={listing.requests.find((request) => request.id === chooseTarget) ?? null}
      />
    </Page>
  );
}

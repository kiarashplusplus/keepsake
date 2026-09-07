// Dashboard detail: photos, story, status/moderation copy, and the owner
// actions (Edit, Mark given, Withdraw/Relist, Delete). Requests are M3 —
// this always shows the "share the link" empty state for now.
import * as React from "react";
import { View } from "react-native";
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
import { deleteListing, markGiven, relistListing, withdrawListing } from "@/api/listings";
import { ApiError } from "@/api/client";
import { RequestList } from "@/features/mine/RequestList";
import { HandoffSheet } from "@/features/mine/HandoffSheet";
import { track } from "@/lib/analytics";
import { AnalyticsEvents } from "@/lib/analyticsEvents";

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
        <EmptyState eyebrow="Mine" title="Couldn't load this listing" line={error} />
      </Page>
    );
  }

  if (listing === null) {
    return (
      <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal, gap: space.md }}>
        <Skeleton height={200} />
        <Skeleton height={80} />
      </Page>
    );
  }

  const canShowFull = listing.status === "approved" || listing.status === "given";
  const status = STATUS_LABELS[listing.status];
  const rule = { borderBottomWidth: 2, borderBottomColor: colors.ink, paddingBottom: space.sm };

  return (
    <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal, gap: space.xl }}>
      {/* Photos as small prints, each leaning its own deterministic way. */}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.lg, paddingTop: space.sm }}>
        {listing.photos.map((photo) => (
          <Print key={photo.id} tiltDeg={tiltDegForId(photo.id, motion.tiltRangeDeg)} style={{ width: THUMB, height: THUMB, padding: 6 }}>
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

      <Card style={{ gap: space.xl }}>
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
          <RequestList
            requests={listing.requests}
            canChoose={listing.chosen_request_id === null && listing.status === "approved"}
            busy={busy || choosing}
            onChoose={setChooseTarget}
          />
        </View>

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
      />
    </Page>
  );
}

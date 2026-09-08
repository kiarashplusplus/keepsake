// Dashboard: every listing this device's owner token has ever created,
// grouped into Reviewing / Live / Needs attention / Given / Withdrawn, with
// anything the giver is unknowingly holding up flagged on the row it belongs
// to (`features/mine/staleness.ts`).
import * as React from "react";
import { Pressable, View } from "react-native";
import { Link, useLocalSearchParams, useRouter } from "expo-router";
import { Image as ExpoImage } from "expo-image";
import { motion } from "@keepsake/tokens/motion";
import { sectionRhythm, space } from "@keepsake/tokens/spacing";
import { MODERATION_REASONS, type ListingStatus, type OwnerDashboardListing } from "@keepsake/contracts/listing";
import { Page } from "@/ui/Page";
import { EmptyState } from "@/ui/EmptyState";
import { Eyebrow } from "@/ui/Eyebrow";
import { Button } from "@/ui/Button";
import { Print } from "@/ui/Print";
import { Card } from "@/ui/Surface";
import { PencilRule } from "@/ui/PencilRule";
import { TableHeading } from "@/ui/TableHeading";
import { Text, type TextColor } from "@/ui/Text";
import { Skeleton } from "@/ui/Skeleton";
import { Stamp } from "@/ui/Stamp";
import { useColors } from "@/ui/theme";
import { useToast } from "@/ui/Toast";
import { getOwnerToken } from "@/lib/ownerToken";
import { getMyListings } from "@/api/me";
import { listBatches } from "@/api/bulk";
import type { BatchSummary } from "@keepsake/contracts/bulk";
import { ApiError } from "@/api/client";
import { tiltDegForId } from "@/lib/masonry";
import { LISTING_GROUP_LABELS, LISTING_GROUP_ORDER, groupListings } from "@/features/mine/groupListings";
import { OWNER_EMAIL_PROBLEM_COPY, ownerEmailProblem, staleSummary } from "@/features/mine/staleness";

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

function ListingRow({ listing }: { listing: OwnerDashboardListing }): React.ReactElement {
  const colors = useColors();
  const cover = listing.photos[0];
  const canShowFull = listing.status === "approved" || listing.status === "given";
  const status = STATUS_LABELS[listing.status];
  const tiltDeg = tiltDegForId(listing.id, motion.tiltRangeDeg / 2);
  // The row has one line to spare, so it carries the first reason only —
  // they arrive in priority order, and the detail page lists them all.
  const needsYou = staleSummary(listing.staleness);

  return (
    <Link href={{ pathname: "/mine/[id]", params: { id: listing.id } }} asChild>
      <Pressable accessibilityRole="button" accessibilityLabel={`Open ${listing.title}`}>
        <Print
          interactive
          tiltDeg={tiltDeg}
          style={{ flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md }}
        >
          <View style={{ width: 64, height: 64, overflow: "hidden", backgroundColor: colors.tableEdge }}>
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
            {needsYou !== null ? (
              <Text variant="caption" color="dangerText" numberOfLines={1}>
                {needsYou}
              </Text>
            ) : null}
          </View>
          {/* The status word is what moderation decided; "Needs you" is what
              is true regardless of it — a live listing with a stranger
              waiting on it is not, in any useful sense, fine. */}
          <Text variant="label" color={needsYou !== null ? "dangerText" : status.color} style={{ fontSize: 10 }}>
            {needsYou !== null ? "Needs you" : status.label}
          </Text>
        </Print>
      </Pressable>
    </Link>
  );
}

/**
 * The batches this owner is still preparing — draft ones only, a private
 * filter over `GET /api/bulk/batches` (that route already returns every
 * state; this is the one narrowing "Continue preparing" ever needs). A 404
 * (feature off, or no batch ever started on this device) degrades to
 * simply not showing the section — Mine's whole point is the ordinary give
 * flow, and a pilot feature being off is not something to alarm a visitor
 * with here.
 */
function useDraftBulkBatches(hasOwnerToken: boolean): BatchSummary[] {
  const [batches, setBatches] = React.useState<BatchSummary[]>([]);

  React.useEffect(() => {
    if (!hasOwnerToken) return;
    let cancelled = false;
    listBatches()
      .then((result) => {
        if (!cancelled) setBatches(result.filter((b) => b.state === "draft"));
      })
      .catch(() => {
        // Silent — see this hook's own header.
      });
    return () => {
      cancelled = true;
    };
  }, [hasOwnerToken]);

  return batches;
}

function DraftBatchesSection({ batches }: { batches: BatchSummary[] }): React.ReactElement | null {
  if (batches.length === 0) return null;
  return (
    <View style={{ gap: space.md }}>
      <TableHeading note={`${batches.length} in progress`}>Estate batches</TableHeading>
      <View style={{ gap: space.sm }}>
        {batches.map((batch) => (
          <Link key={batch.id} href={{ pathname: "/bulk/[batchKey]/photos", params: { batchKey: batch.client_batch_key } }} asChild>
            <Pressable accessibilityRole="button" accessibilityLabel={`Continue preparing ${batch.name}`}>
              <Print interactive tiltDeg={0} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: space.md }}>
                <View style={{ gap: space.xxs, flex: 1 }}>
                  <Text variant="title" numberOfLines={1}>
                    {batch.name}
                  </Text>
                  <Text variant="caption" color="textTertiary">
                    {batch.item_count} item{batch.item_count === 1 ? "" : "s"} · {batch.ready_count} ready
                  </Text>
                </View>
                <Text variant="label" color="accentText" style={{ fontSize: 10 }}>
                  Continue
                </Text>
              </Print>
            </Pressable>
          </Link>
        ))}
      </View>
    </View>
  );
}

export default function Mine(): React.ReactElement {
  useVerifiedToast();
  const [hasOwnerToken] = React.useState(() => getOwnerToken() !== null);
  const [listings, setListings] = React.useState<OwnerDashboardListing[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const draftBatches = useDraftBulkBatches(hasOwnerToken);

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
      <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal }}>
        <EmptyState
          ornament={<Stamp state="idle" label="Mine" />}
          eyebrow="Mine"
          title="You haven't given anything yet."
          line="Once you give something, it'll show up here so you can follow along."
          action={
            <View style={{ gap: space.lg, alignItems: "center" }}>
              <Link href="/give" dangerouslySingular asChild>
                <Button label="Give something" />
              </Link>
              <Link href="/bulk" asChild>
                <Button label="Give several items" variant="link" />
              </Link>
              <Link href="/recover" asChild>
                <Button label="Lost your listings?" variant="link" />
              </Link>
            </View>
          }
        />
      </Page>
    );
  }

  if (error !== null) {
    return (
      <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal }}>
        <EmptyState eyebrow="Mine" title="Couldn't load your listings" line={error} />
      </Page>
    );
  }

  if (listings === null) {
    return (
      <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal, gap: space.md }}>
        <Skeleton height={88} />
        <Skeleton height={88} />
        <Skeleton height={88} />
      </Page>
    );
  }

  if (listings.length === 0) {
    return (
      <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal, gap: sectionRhythm.tight }}>
        <EmptyState
          ornament={<Stamp state="idle" label="Mine" />}
          eyebrow="Mine"
          title="You haven't given anything yet."
          line="Once you give something, it'll show up here so you can follow along."
          action={
            <View style={{ gap: space.lg, alignItems: "center" }}>
              <Link href="/give" dangerouslySingular asChild>
                <Button label="Give something" />
              </Link>
              <Link href="/bulk" asChild>
                <Button label="Give several items" variant="link" />
              </Link>
            </View>
          }
        />
        <DraftBatchesSection batches={draftBatches} />
      </Page>
    );
  }

  const groups = groupListings(listings);
  // One banner for the whole account rather than the same sentence repeated
  // down every row: an unreachable mailbox is one problem with one fix, and
  // the rows still carry their own line for the listing-specific half.
  const emailProblem = ownerEmailProblem(listings);

  return (
    <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal }}>
      <Card style={{ gap: sectionRhythm.tight, transform: [{ rotate: "0.2deg" }] }}>
        <View style={{ flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", flexWrap: "wrap", gap: space.md }}>
          <View style={{ gap: space.sm }}>
            <Eyebrow tick>Your keepsakes</Eyebrow>
            <Text variant="displayLg">Mine</Text>
          </View>
          <View style={{ flexDirection: "row", gap: space.md }}>
            <Link href="/bulk" asChild>
              <Button label="Give several items" variant="link" arrow={false} />
            </Link>
            <Link href="/mine/email" asChild>
              <Button label="Email" variant="link" arrow={false} />
            </Link>
          </View>
        </View>
        <PencilRule />
      </Card>
      {emailProblem !== null ? (
        <Card style={{ gap: space.md, transform: [{ rotate: "-0.4deg" }] }}>
          <Eyebrow color="dangerText">{OWNER_EMAIL_PROBLEM_COPY[emailProblem].title}</Eyebrow>
          <Text variant="body" color="inkSoft">
            {OWNER_EMAIL_PROBLEM_COPY[emailProblem].line}
          </Text>
          <View style={{ flexDirection: "row" }}>
            <Link href="/mine/email" asChild>
              <Button label={OWNER_EMAIL_PROBLEM_COPY[emailProblem].action} />
            </Link>
          </View>
        </Card>
      ) : null}
      <DraftBatchesSection batches={draftBatches} />
      <View style={{ gap: sectionRhythm.normal, marginTop: sectionRhythm.tight }}>
        {LISTING_GROUP_ORDER.map((key) => {
          const group = groups[key];
          if (group.length === 0) return null;
          return (
            <View key={key} style={{ gap: space.lg }}>
              {/* Issue #216: this was a bare `Eyebrow` under a 2px
                  `colors.ink` rule, both sitting straight on the table. `ink`
                  and `accent2Text` are constant by design (a print does not
                  change colour when the lights go down), so on the walnut
                  dark table the "Live" heading measured 1.12:1 and the rule
                  under it was equally gone. `TableHeading` prints the same
                  words on their own paper strip instead — 14.25:1 in both
                  themes, and the strip's own edge is the section break the
                  rule used to draw. */}
              <TableHeading>{LISTING_GROUP_LABELS[key]}</TableHeading>
              <View style={{ gap: space.lg }}>
                {group.map((listing) => (
                  <ListingRow key={listing.id} listing={listing} />
                ))}
              </View>
            </View>
          );
        })}
      </View>
    </Page>
  );
}

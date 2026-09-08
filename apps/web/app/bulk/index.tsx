// Estate batches: every batch this device's owner token has (or a verified
// email recovered), with a "Continue preparing" entry into each and a way
// to start a new one. Linked from My Keepsakes (`app/mine/index.tsx`).
import * as React from "react";
import { View } from "react-native";
import { Link, useRouter } from "expo-router";
import { sectionRhythm, space } from "@keepsake/tokens/spacing";
import type { BatchSummary } from "@keepsake/contracts/bulk";
import { Page } from "@/ui/Page";
import { Text } from "@/ui/Text";
import { Eyebrow } from "@/ui/Eyebrow";
import { Button } from "@/ui/Button";
import { Card } from "@/ui/Surface";
import { Skeleton } from "@/ui/Skeleton";
import { EmptyState } from "@/ui/EmptyState";
import { Stamp } from "@/ui/Stamp";
import { RouteHead } from "@/ui/RouteHead";
import { listBatches } from "@/api/bulk";
import { ApiError } from "@/api/client";
import { getOwnerToken } from "@/lib/ownerToken";

const STATE_LABEL: Record<BatchSummary["state"], string> = {
  draft: "Preparing",
  submitting: "Submitting",
  closed: "Closed",
  cancelled: "Cancelled",
};

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function BatchRow({ batch }: { batch: BatchSummary }): React.ReactElement {
  return (
    <Card style={{ gap: space.sm }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: space.md }}>
        <View style={{ gap: space.xxs, flex: 1 }}>
          <Text variant="title" numberOfLines={1}>
            {batch.name}
          </Text>
          <Text variant="caption" color="textTertiary">
            {batch.item_count} item{batch.item_count === 1 ? "" : "s"} · {batch.ready_count} ready · {batch.photo_count} photo{batch.photo_count === 1 ? "" : "s"}
          </Text>
        </View>
        <Text variant="label" color={batch.state === "draft" ? "foilText" : "textTertiary"} style={{ fontSize: 10 }}>
          {STATE_LABEL[batch.state]}
        </Text>
      </View>
      <Text variant="caption" color="textTertiary">
        Last saved {formatDate(batch.updated_at)} · drafts expire {formatDate(batch.expires_at)}
      </Text>
      <View style={{ flexDirection: "row" }}>
        <Link href={{ pathname: "/bulk/[batchKey]/photos", params: { batchKey: batch.client_batch_key } }} asChild>
          <Button label="Continue preparing" variant="secondary" />
        </Link>
      </View>
    </Card>
  );
}

export default function BulkBatchList(): React.ReactElement {
  const router = useRouter();
  const [hasOwnerToken] = React.useState(() => getOwnerToken() !== null);
  const [batches, setBatches] = React.useState<BatchSummary[] | null>(null);
  const [unavailable, setUnavailable] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!hasOwnerToken) return;
    let cancelled = false;
    listBatches()
      .then((result) => {
        if (!cancelled) setBatches(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // A 404 means the feature is off for this build — not that anything
        // is broken. Degrading honestly (per this feature's plan) beats a
        // spinner that never resolves or a raw error banner.
        if (err instanceof ApiError && err.code === "not_found") {
          setUnavailable(true);
          return;
        }
        // A 401 means this device minted an owner token locally but the
        // server has never seen it — no give, no batch, nothing to list.
        // That is an ordinary new visitor, not a failure: the honest answer
        // is an empty list, and `POST /api/bulk/batches` creates the row the
        // moment they start one (`ownerAuth({ createIfMissing: true })`).
        // Before the admission code was removed this state was unreachable
        // here — an operator had already minted a grant against an existing
        // `owners` row — so it read as an error and took the whole screen,
        // "Start a new batch" included.
        if (err instanceof ApiError && err.code === "unauthorized") {
          setBatches([]);
          return;
        }
        setError(err instanceof ApiError ? err.message : "Couldn't load your batches.");
      });
    return () => {
      cancelled = true;
    };
  }, [hasOwnerToken]);

  if (unavailable) {
    return (
      <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal }}>
        <RouteHead title="Give several items" />
        <EmptyState
          ornament={<Stamp state="idle" label="Estate" />}
          eyebrow="Give several items"
          title="Not open on this build yet."
          line="Estate clear-out batches are a pilot feature. If you were expecting this, ask whoever set it up for you."
        />
      </Page>
    );
  }

  return (
    <Page variant="prose" contentContainerStyle={{ paddingVertical: sectionRhythm.normal, gap: sectionRhythm.tight }}>
      <RouteHead title="Give several items" description="Prepare many keepsakes over several sittings, then publish the ready ones together." />
      <Card style={{ gap: sectionRhythm.tight, transform: [{ rotate: "0.2deg" }] }}>
        <View style={{ gap: space.sm }}>
          <Eyebrow tick>Estate clear-outs</Eyebrow>
          <Text variant="displayLg">Give several items</Text>
          <Text variant="bodyLg" color="textSecondary">
            Prepare many keepsakes over several sittings, then publish the ready ones together.
          </Text>
        </View>
        <View style={{ flexDirection: "row" }}>
          <Button label="Start a new batch" onPress={() => router.push("/bulk/new")} />
        </View>
      </Card>

      {error !== null ? (
        // Under the card, never instead of it: whatever went wrong listing
        // batches that already exist, starting a new one is still possible
        // and is the one thing this screen is for.
        <Text variant="body" color="dangerText">
          {`Couldn't load your batches. ${error}`}
        </Text>
      ) : !hasOwnerToken ? null : batches === null ? (
        <View style={{ gap: space.md }}>
          <Skeleton height={96} />
          <Skeleton height={96} />
        </View>
      ) : batches.length === 0 ? null : (
        <View style={{ gap: space.md }}>
          {batches.map((batch) => (
            <BatchRow key={batch.id} batch={batch} />
          ))}
        </View>
      )}
    </Page>
  );
}

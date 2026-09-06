/**
 * One held/hidden/pending/rejected listing as Kiarash sees it: every photo,
 * the story, who posted it, why the pipeline (or a report) landed it here,
 * and the stamped actions available for whatever tab it's in. `actions` is
 * computed once per tab in `app/admin.tsx` (`ACTIONS_BY_STATUS` below) since
 * `GET /api/admin/queue?status=` only ever returns rows of that one status —
 * every card in a tab shares the same action set.
 */
import * as React from "react";
import { View } from "react-native";
import { Image as ExpoImage } from "expo-image";
import { motion } from "@keepsake/tokens/motion";
import { space } from "@keepsake/tokens/spacing";
import { CATEGORY_LABELS } from "@keepsake/contracts/listing";
import type { AdminQueueItem, AdminQueueStatus } from "@keepsake/contracts/admin";
import { REPORT_REASON_LABELS } from "@keepsake/contracts/report";
import { Print } from "@/ui/Print";
import { Card } from "@/ui/Surface";
import { Text } from "@/ui/Text";
import { Eyebrow } from "@/ui/Eyebrow";
import { Button } from "@/ui/Button";
import { useColors } from "@/ui/theme";
import { tiltDegForId } from "@/lib/masonry";
import { relativeTime } from "@/lib/relativeTime";

export type QueueActionSet = { approve: boolean; hide: boolean; restore: boolean; reject: boolean };

/** Which listing-level actions apply to every row of a given tab — see this
 * file's header comment for why this is keyed by tab rather than by item.
 * Mirrors `apps/api/src/routes/admin.ts`'s `APPROVABLE_STATUSES` (approve
 * accepts needs_review/pending/hidden, never rejected) and its restore
 * route (hidden only). */
export const ACTIONS_BY_STATUS: Record<AdminQueueStatus, QueueActionSet> = {
  needs_review: { approve: true, hide: true, restore: false, reject: true },
  pending: { approve: true, hide: true, restore: false, reject: true },
  hidden: { approve: false, hide: false, restore: true, reject: true },
  rejected: { approve: false, hide: false, restore: false, reject: false },
};

const THUMB = 96;

function PhotoThumb({ photo }: { photo: AdminQueueItem["photos"][number] }): React.ReactElement {
  const colors = useColors();
  const [failed, setFailed] = React.useState(false);

  return (
    <View style={{ width: THUMB, height: THUMB, overflow: "hidden", backgroundColor: colors.tableEdge }}>
      <ExpoImage
        source={failed ? null : photo.url_thumb}
        placeholder={{ blurhash: photo.blurhash }}
        onError={() => setFailed(true)}
        style={{ width: "100%", height: "100%" }}
        contentFit="cover"
        accessibilityLabel=""
      />
    </View>
  );
}

function EventRow({ event }: { event: AdminQueueItem["events"][number] }): React.ReactElement {
  const flagsText = event.flags !== null && event.flags !== undefined ? JSON.stringify(event.flags) : null;
  return (
    <View style={{ gap: 2 }}>
      <Text variant="caption" color="textSecondary">
        {`[${relativeTime(event.created_at)}] ${event.kind} → ${event.verdict}${event.model !== null ? ` (${event.model})` : ""}${
          event.latency_ms !== null ? ` ${event.latency_ms}ms` : ""
        } attempt ${event.attempt}`}
      </Text>
      {event.reason !== null ? (
        <Text variant="caption" color="textTertiary">
          {`  reason: ${event.reason}`}
        </Text>
      ) : null}
      {flagsText !== null ? (
        <Text variant="caption" color="textTertiary">
          {`  flags: ${flagsText}`}
        </Text>
      ) : null}
    </View>
  );
}

function ReportRow({ report }: { report: AdminQueueItem["reports"][number] }): React.ReactElement {
  return (
    <View style={{ gap: 2 }}>
      <Text variant="caption" color="textSecondary">
        {`[${relativeTime(report.created_at)}] ${REPORT_REASON_LABELS[report.reason]}`}
      </Text>
      {report.details !== null ? (
        <Text variant="caption" color="textTertiary">
          {`  "${report.details}"`}
        </Text>
      ) : null}
    </View>
  );
}

export type QueueItemCardProps = {
  item: AdminQueueItem;
  actions: QueueActionSet;
  busy: boolean;
  onApprove: () => void;
  onHide: () => void;
  onRestore: () => void;
  onReject: () => void;
  onBanOwner: () => void;
  onUnbanOwner: () => void;
};

export function QueueItemCard({ item, actions, busy, onApprove, onHide, onRestore, onReject, onBanOwner, onUnbanOwner }: QueueItemCardProps): React.ReactElement {
  return (
    <Card style={{ gap: space.lg }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
        {item.photos.length > 0 ? (
          item.photos.map((photo) => (
            <Print key={photo.id} tape={false} tiltDeg={tiltDegForId(photo.id, motion.tiltRangeDeg)} style={{ width: THUMB + 8, padding: 4 }}>
              <PhotoThumb photo={photo} />
            </Print>
          ))
        ) : (
          <Text variant="caption" color="textTertiary">
            No photos.
          </Text>
        )}
      </View>

      <View style={{ gap: space.xs }}>
        <Text variant="title">{item.title}</Text>
        <Text variant="body" color="inkSoft">
          {item.story}
        </Text>
        <Text variant="caption" color="textTertiary">
          {`${CATEGORY_LABELS[item.category]} · ${item.place_name}${item.admin1 !== null ? `, ${item.admin1}` : ""} · posted ${relativeTime(item.created_at)}`}
        </Text>
      </View>

      <View style={{ gap: space.xxs }}>
        <Eyebrow>Giver</Eyebrow>
        <Text variant="caption" color="textSecondary">
          {`${item.owner.email_masked ?? "no email on file"} · ${item.owner.email_verified ? "verified" : "unverified"}${item.owner.banned ? " · BANNED" : ""}`}
        </Text>
      </View>

      <View style={{ gap: space.xxs }}>
        <Eyebrow>{`Reports (${item.report_count})`}</Eyebrow>
        {item.reports.length === 0 ? (
          <Text variant="caption" color="textTertiary">
            None.
          </Text>
        ) : (
          item.reports.map((report, index) => <ReportRow key={index} report={report} />)
        )}
      </View>

      <View style={{ gap: space.xxs }}>
        <Eyebrow>Moderation history</Eyebrow>
        {item.events.length === 0 ? (
          <Text variant="caption" color="textTertiary">
            No events yet.
          </Text>
        ) : (
          item.events.map((event, index) => <EventRow key={index} event={event} />)
        )}
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.md }}>
        {actions.approve ? <Button label="Approve" disabled={busy} onPress={onApprove} /> : null}
        {actions.restore ? <Button label="Restore" disabled={busy} onPress={onRestore} /> : null}
        {actions.hide ? <Button label="Hide" variant="secondary" disabled={busy} onPress={onHide} /> : null}
        {actions.reject ? <Button label="Reject" variant="secondary" disabled={busy} onPress={onReject} /> : null}
        {item.owner.banned ? (
          <Button label="Unban owner" variant="ghost" disabled={busy} onPress={onUnbanOwner} />
        ) : (
          <Button label="Ban owner" variant="ghost" disabled={busy} onPress={onBanOwner} />
        )}
      </View>
    </Card>
  );
}

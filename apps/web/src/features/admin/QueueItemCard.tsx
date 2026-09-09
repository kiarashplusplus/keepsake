/**
 * One held/hidden/pending/rejected listing as Kiarash sees it: every photo,
 * the story, who posted it, why the pipeline (or a report) landed it here,
 * and the stamped actions available for whatever tab it's in. `actions` is
 * computed once per tab in `app/admin.tsx` (`ACTIONS_BY_STATUS` below) since
 * `GET /api/admin/queue?status=` only ever returns rows of that one status —
 * every card in a tab shares the same action set.
 */
import * as React from "react";
import { Pressable, View } from "react-native";
import { Image as ExpoImage } from "expo-image";
import { motion } from "@keepsake/tokens/motion";
import { radii } from "@keepsake/tokens/radii";
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
import { formatFlagsLine } from "@/features/admin/moderationFlags";

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
    <View
      style={{ width: THUMB, height: THUMB, overflow: "hidden", backgroundColor: colors.tableEdge }}
    >
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

/**
 * One `moderation_events` row. `flags` is summarised to what was actually
 * raised (`moderationFlags.ts`, #363) — the whole scorecard used to print as
 * one `JSON.stringify` string, which at 390px wrapped mid-token into four
 * lines of zeros per image pass and made the history block the tallest
 * thing on the card. `showRaw` puts the full JSON back, for every event on
 * the card at once, from the disclosure under the block.
 */
function EventRow({ event, showRaw }: { event: AdminQueueItem["events"][number]; showRaw: boolean }): React.ReactElement {
  const hasFlags = event.flags !== null && event.flags !== undefined;
  const flagsLine = hasFlags ? formatFlagsLine(event.flags) : null;
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
      {flagsLine !== null ? (
        <Text variant="caption" color="textTertiary">
          {`  flags: ${flagsLine}`}
        </Text>
      ) : null}
      {showRaw && hasFlags ? (
        <Text variant="caption" color="textTertiary">
          {`  raw: ${JSON.stringify(event.flags)}`}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The moderation-history block: every event summarised, plus — only when
 * at least one event carries `flags` — a "Show raw" toggle that reveals the
 * stored JSON under each of them. One toggle per card rather than per
 * event: a card has two or three image passes and a moderator wanting the
 * raw scorecard wants all of them, not a link per line.
 */
function ModerationHistory({ events }: { events: AdminQueueItem["events"] }): React.ReactElement {
  const colors = useColors();
  const [showRaw, setShowRaw] = React.useState(false);
  const anyFlags = events.some((event) => event.flags !== null && event.flags !== undefined);
  return (
    <View style={{ gap: space.xxs }}>
      <Eyebrow>Moderation history</Eyebrow>
      {events.length === 0 ? (
        <Text variant="caption" color="textTertiary">
          No events yet.
        </Text>
      ) : (
        events.map((event, index) => <EventRow key={index} event={event} showRaw={showRaw} />)
      )}
      {anyFlags ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={showRaw ? "Hide raw flags" : "Show raw flags"}
          {...({ "aria-expanded": showRaw } as object)}
          onPress={() => setShowRaw((previous) => !previous)}
          hitSlop={space.sm}
          style={({ pressed }: { pressed: boolean }) => ({
            alignSelf: "flex-start",
            marginTop: space.xxs,
            borderBottomWidth: 1,
            borderBottomColor: colors.ink,
            opacity: pressed ? 0.75 : 1,
          })}
        >
          <Text variant="caption" color="ink">
            {showRaw ? "Hide raw" : "Show raw"}
          </Text>
        </Pressable>
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
  /** Whether the keyboard's roving focus (`app/admin.tsx`'s j/k navigation)
   * currently sits on this row — distinct from real DOM focus on one of its
   * buttons, though this drives that too (see the effect below). */
  focused: boolean;
  /** In the bulk-selection set, independent of `focused` — a card can be
   * checked without being the one keyboard shortcuts currently act on. */
  selected: boolean;
  onToggleSelect: () => void;
  onApprove: () => void;
  onHide: () => void;
  onRestore: () => void;
  onReject: () => void;
  onBanOwner: () => void;
  onUnbanOwner: () => void;
};

export function QueueItemCard({
  item,
  actions,
  busy,
  focused,
  selected,
  onToggleSelect,
  onApprove,
  onHide,
  onRestore,
  onReject,
  onBanOwner,
  onUnbanOwner,
}: QueueItemCardProps): React.ReactElement {
  const colors = useColors();
  // `View`'s ref forwards straight to its DOM node on web (same fact
  // `src/ui/Sheet.tsx`'s focus trap relies on), so arrow-key navigation in
  // `app/admin.tsx` can flip `focused` to true and this card moves real
  // keyboard/screen-reader focus onto itself without the parent needing to
  // hold per-row refs of its own.
  const outerRef = React.useRef<View>(null);
  React.useEffect(() => {
    if (!focused) return;
    const node = outerRef.current as unknown as HTMLElement | null;
    node?.focus?.({ preventScroll: true });
    node?.scrollIntoView?.({ block: "nearest" });
  }, [focused]);

  return (
    <View
      ref={outerRef}
      // `tabIndex={-1}`: reachable by the arrow-key roving focus above and
      // by screen readers once focused, but deliberately not part of the
      // normal Tab order — with up to 200 rows in a queue, forcing every
      // card itself into Tab order would make Tab the slow path instead of
      // the fast one. Its buttons keep their own natural tab stops either
      // way, so nothing on the card becomes unreachable without a mouse.
      {...({ tabIndex: -1 } as object)}
      role="group"
      accessibilityLabel={`${item.title}, posted ${relativeTime(item.created_at)}`}
      style={{
        borderRadius: radii.md,
        borderWidth: focused ? 3 : 0,
        borderColor: colors.accent,
        margin: focused ? 0 : 3,
      }}
    >
      <Card style={{ gap: space.lg }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: space.md,
          }}
        >
          <Pressable
            accessibilityRole="checkbox"
            accessibilityLabel={`Select ${item.title}`}
            // Not `accessibilityState={{ checked: selected }}`: the
            // installed react-native-web (0.21) only wires that aggregate
            // prop through for a couple of native-only components, not
            // `View`/`Pressable` generally, so it silently produces no
            // `aria-checked` at all — caught by axe's `aria-required-attr`,
            // which treats a `role="checkbox"` with no `aria-checked` as a
            // critical violation. `aria-checked` directly (cast through
            // `object`, same as `role`/`tabIndex` elsewhere in this file) is
            // a prop react-native-web does forward as-is.
            {...({ "aria-checked": selected } as object)}
            onPress={onToggleSelect}
            style={({ pressed }: { pressed: boolean }) => ({
              width: 24,
              height: 24,
              borderWidth: 2,
              borderColor: colors.ink,
              backgroundColor: selected ? colors.accent : colors.surface,
              alignItems: "center",
              justifyContent: "center",
              opacity: pressed ? 0.75 : 1,
            })}
          >
            {selected ? (
              <Text variant="label" color="onAccent" style={{ fontSize: 14, lineHeight: 14 }}>
                ✓
              </Text>
            ) : null}
          </Pressable>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
          {item.photos.length > 0 ? (
            item.photos.map((photo) => (
              <Print
                key={photo.id}
                tape={false}
                tiltDeg={tiltDegForId(photo.id, motion.tiltRangeDeg)}
                style={{ width: THUMB + 8, padding: 4 }}
              >
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

        <ModerationHistory events={item.events} />

        <View
          style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.md }}
        >
          {actions.approve ? <Button label="Approve" disabled={busy} onPress={onApprove} /> : null}
          {actions.restore ? <Button label="Restore" disabled={busy} onPress={onRestore} /> : null}
          {actions.hide ? (
            <Button label="Hide" variant="secondary" disabled={busy} onPress={onHide} />
          ) : null}
          {actions.reject ? (
            <Button label="Reject" variant="secondary" disabled={busy} onPress={onReject} />
          ) : null}
          {item.owner.banned ? (
            <Button label="Unban owner" variant="ghost" disabled={busy} onPress={onUnbanOwner} />
          ) : (
            <Button label="Ban owner" variant="ghost" disabled={busy} onPress={onBanOwner} />
          )}
        </View>
      </Card>
    </View>
  );
}

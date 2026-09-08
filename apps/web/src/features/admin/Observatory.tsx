/**
 * The Observatory panel: `GET /api/admin/observatory`, rendered.
 *
 * Reading order is deliberate, not alphabetical: `report.needs_attention`
 * first (the one thing worth a glance even if nothing else on this page is
 * ever opened), then moderation latency (is anything stuck), the funnel
 * (absolute counts, on purpose — see `ObservatoryFunnel`'s doc comment on
 * why this never divides), the two day-by-day series, and finally the raw
 * log feed, which is the most detail and the least "read every day."
 *
 * The three-state `ObservatorySource` is the one piece of this file that is
 * not allowed to get simpler. Collapsing "not configured" and "the call
 * failed" into one rendering — an empty chart, a dash, a zero — is exactly
 * the defect the contract's own file header calls out (the `/admin/health`
 * verdict that ignored its own cron timestamps, issue #89's silent
 * auto-hides). `SourceSection` below is the one place that distinction is
 * drawn, so every caller gets it for free and nobody can regress it by
 * writing `source.data ?? 0` somewhere else in this file.
 */
import * as React from "react";
import { View, type ViewStyle } from "react-native";
import { space, sectionRhythm } from "@keepsake/tokens/spacing";
import type {
  DailyReportAlert,
  ObservatoryApp as ObservatoryAppData,
  ObservatoryBulk,
  ObservatoryEdge,
  ObservatoryFunnel,
  ObservatoryLogEvent,
  ObservatoryLogs,
  ObservatoryModerationLatency,
  ObservatorySearchIndex,
  ObservatorySource,
  Observatory as ObservatoryData,
} from "@keepsake/contracts/observatory";
import { OBSERVATORY_WINDOWS } from "@keepsake/contracts/observatory";
import { Text } from "@/ui/Text";
import { Chip } from "@/ui/Chip";
import { Stamp } from "@/ui/Stamp";
import { EmptyState } from "@/ui/EmptyState";
import { Skeleton } from "@/ui/Skeleton";
import { useColors } from "@/ui/theme";
import { getObservatory } from "@/api/observatory";
import { ApiError } from "@/api/client";
// Reused rather than re-implemented: the queue's own "4 min ago"/"2 hr ago"
// clock, so a log event's age and a stale cron's age never disagree about
// what "2 hr ago" means anywhere in `/admin`.
import { formatAgo } from "@/features/admin/StatsStrip";

type ObservatoryWindow = (typeof OBSERVATORY_WINDOWS)[number];

// ---------------------------------------------------------------------------
// Pure helpers — exported for the same reason `StatsStrip.tsx` exports
// `formatAgo`/`isCronStale`: a formatting rule that only exists inside a
// render function is a formatting rule nothing can unit-test without a DOM.
// ---------------------------------------------------------------------------

/**
 * "4h 12m" / "3d 2h" / "12m" / "<1m" — a duration, not a clock reading. Every
 * `*_age_ms`/`*_time_to_decision_ms` field this renders is already a
 * duration (milliseconds elapsed), never a timestamp, so this never touches
 * `Date.now()` — unlike `formatAgo` above, which converts a timestamp into
 * one. Callers own the `null` case (see `AgeRow`): a missing duration and a
 * zero duration mean different things and must never share a code path.
 */
export function formatDurationMs(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return "<1m";
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** `ObservatoryBulkFunnel.orphan_bytes` in the largest sensible unit — same
 * "read cold" rule `formatDurationMs` follows, and the same formatting the
 * daily digest's `byteWords` uses, so a number quoted from the email and the
 * same number read off this page never disagree in shape. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

// ---------------------------------------------------------------------------
// Small stamped-badge primitives, in the same visual language `StatsStrip`
// already established (ink-outlined box, a count, a mono caption). Not
// imported from there — those are private to that file — so duplicated here
// rather than exporting three one-off components across a file boundary for
// a single sibling caller.
// ---------------------------------------------------------------------------

function StatBadge({ label, value }: { label: string; value: number }): React.ReactElement {
  const colors = useColors();
  return (
    <View
      style={{
        borderWidth: 2,
        borderColor: colors.ink,
        backgroundColor: colors.surface,
        paddingVertical: space.sm,
        paddingHorizontal: space.md,
        minWidth: 92,
        alignItems: "center",
        gap: space.xxs,
      }}
    >
      <Text variant="displayMd">{value}</Text>
      <Text variant="label" color="textSecondary" style={{ fontSize: 10, textAlign: "center" }}>
        {label}
      </Text>
    </View>
  );
}

/** One line of `label: value(-or-nullLabel)` — the moderation-latency rows.
 * `ms === null` and `ms === 0` are rendered through completely different
 * branches (a sentence vs. a duration) so they can never collapse into the
 * same string; see `ObservatoryModerationLatency`'s doc comment on why the
 * two must stay distinguishable all the way to the screen. */
function AgeRow({ label, ms, nullLabel }: { label: string; ms: number | null; nullLabel: string }): React.ReactElement {
  const value = ms === null ? nullLabel : formatDurationMs(ms);
  return (
    <View accessibilityRole="text" accessibilityLabel={`${label}: ${value}`} style={{ flexDirection: "row", gap: space.sm }}>
      <Text variant="caption" color="textSecondary" style={{ width: 168 }}>
        {label}
      </Text>
      <Text variant="caption" color={ms === null ? "textTertiary" : "ink"}>
        {value}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// A day-by-day bar, built from two `View`s and a percentage width — no
// charting dependency, per the task's own constraint. The accessible name
// carries the real number; the bar itself is a supplementary visual, never
// the only place the value lives (an axe run against `/admin` would have
// nothing to read off a bare `<div style="width: 40%">`).
// ---------------------------------------------------------------------------

function BarRow({ label, value, max }: { label: string; value: number; max: number }): React.ReactElement {
  const colors = useColors();
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <View accessibilityRole="text" accessibilityLabel={`${label}: ${value}`} style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <Text variant="caption" color="textSecondary" style={{ width: 84 }}>
        {label}
      </Text>
      <View style={{ flex: 1, height: 10, borderRadius: 2, backgroundColor: colors.tableEdge, overflow: "hidden" }}>
        <View style={{ width: `${pct}%`, height: "100%", backgroundColor: colors.accent2 } as ViewStyle} />
      </View>
      <Text variant="caption" style={{ width: 40, textAlign: "right" }}>
        {value}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// `report.needs_attention` — first in reading order, and the only section
// styled to demand a glance rather than reward one.
// ---------------------------------------------------------------------------

/** Severity conveyed two ways at once — an explicit "CRITICAL"/"WARNING"
 * word and an ink/danger/warning border — never by color alone. A critical
 * alert also gets the danger-red text a stale cron or an unreviewed
 * auto-hide already uses elsewhere on this page; a warning gets `warning`
 * (contrast-verified the same way, see `packages/tokens/src/colors.ts`'s
 * `TEXT_ON_GROUND_TOKENS`) so it reads as "worth a look" without borrowing
 * the same alarm color as something actively broken. */
function AlertRow({ alert }: { alert: DailyReportAlert }): React.ReactElement {
  const colors = useColors();
  const critical = alert.severity === "critical";
  const tone = critical ? colors.danger : colors.warning;
  const label = critical ? "Critical" : "Warning";
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={`${label}: ${alert.detail}`}
      style={{ borderWidth: 2, borderColor: tone, backgroundColor: colors.surface, padding: space.md, gap: space.xxs }}
    >
      <Text variant="label" style={{ color: tone, fontSize: 10 }}>
        {label.toUpperCase()}
      </Text>
      <Text variant="body">{alert.detail}</Text>
      <Text variant="caption" color="textTertiary">
        {alert.code}
      </Text>
    </View>
  );
}

/** Empty means all clear, and — per the contract's own doc comment on
 * `DailyReport.needs_attention` — this has to say so explicitly, the same
 * "idle" stamp language `app/admin.tsx` already uses for "Nothing waiting."
 * on a clear queue, not a section that just quietly renders nothing. */
function NeedsAttentionSection({ alerts }: { alerts: DailyReportAlert[] }): React.ReactElement {
  if (alerts.length === 0) {
    return (
      <EmptyState
        eyebrow="Needs attention"
        title="All clear"
        line="Nothing needs a look today."
        ornament={<Stamp state="idle" label="clear" />}
      />
    );
  }
  // Critical first regardless of the order the API returned them in — this
  // is the one section where the API's own response order is not the
  // reading order the doc comment above promises.
  const ordered = [...alerts].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1));
  return (
    <View style={{ gap: space.sm }}>
      <Text variant="eyebrow" accessibilityRole="header">{`Needs attention · ${alerts.length}`}</Text>
      <View style={{ gap: space.sm }}>
        {ordered.map((alert, index) => (
          <AlertRow key={`${alert.code}-${index}`} alert={alert} />
        ))}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// `app.moderation` — a count is a level, an age is a verdict (the contract's
// own framing). Both shown, the age rows doing the actual work.
// ---------------------------------------------------------------------------

function ModerationSection({ moderation }: { moderation: ObservatoryModerationLatency }): React.ReactElement {
  return (
    <View style={{ gap: space.sm }}>
      <Text variant="eyebrow" accessibilityRole="header">
        Moderation
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
        <StatBadge label="Pending" value={moderation.pending} />
        <StatBadge label="Needs review" value={moderation.needs_review} />
      </View>
      <View style={{ gap: space.xxs }}>
        <AgeRow label="Oldest pending" ms={moderation.oldest_pending_age_ms} nullLabel="Nothing pending" />
        <AgeRow label="Oldest needs review" ms={moderation.oldest_needs_review_age_ms} nullLabel="Nothing needs review" />
        <AgeRow label="Median time to decision" ms={moderation.median_time_to_decision_ms} nullLabel="No decisions yet" />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// `app.search_index` — issue #208. `listings.vector_indexed_at` recorded that
// a listing had no semantic-search vector and nothing displayed it, which is
// #16's shape again ("computed correctly but never shown on the admin page").
//
// Rendered as an age as well as a count, for the reason the moderation
// section above gives. And the disabled case renders as a sentence rather
// than a zero: with `SEMANTIC_SEARCH` off every listing is un-indexed, and a
// dashboard showing "40 un-indexed" for a feature nobody turned on is worse
// than showing nothing.
// ---------------------------------------------------------------------------

function SearchIndexSection({ searchIndex }: { searchIndex: ObservatorySearchIndex }): React.ReactElement {
  return (
    <View style={{ gap: space.sm }}>
      <Text variant="eyebrow" accessibilityRole="header">
        Search index
      </Text>
      {searchIndex.enabled ? (
        <>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
            <StatBadge label="Approved" value={searchIndex.approved} />
            <StatBadge label="No vector" value={searchIndex.unindexed} />
          </View>
          <View style={{ gap: space.xxs }}>
            <AgeRow
              label="Oldest without a vector"
              ms={searchIndex.oldest_unindexed_age_ms}
              nullLabel="Every approved listing is indexed"
            />
          </View>
        </>
      ) : (
        <Text variant="body">Semantic search is switched off, so nothing is indexed and there is nothing to report.</Text>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// `app.funnel` — absolute counts, never a ratio. See `ObservatoryFunnel`'s
// doc comment: at this catalogue size a single listing moves a percentage by
// double digits, and this section exists specifically not to compute one.
// ---------------------------------------------------------------------------

function FunnelSection({ funnel }: { funnel: ObservatoryFunnel }): React.ReactElement {
  return (
    <View style={{ gap: space.sm }}>
      <Text variant="eyebrow" accessibilityRole="header">{`Give → get funnel · last ${funnel.window_days} ${funnel.window_days === 1 ? "day" : "days"}`}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
        <StatBadge label="Photos uploaded" value={funnel.photos_uploaded} />
        <StatBadge label="Listings created" value={funnel.listings_created} />
        <StatBadge label="Listings approved" value={funnel.listings_approved} />
        <StatBadge label="Requested" value={funnel.listings_requested} />
        <StatBadge label="Chosen" value={funnel.listings_chosen} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// `app.by_day` — always present (D1, no credential needed). `listings_created`
// is the one series charted as bars; the rest of each day's fields would
// need either five overlapping bar scales or a real chart library, and the
// task is explicit that this stays a simple, dependency-free primitive.
// ---------------------------------------------------------------------------

function AppSeriesSection({ byDay }: { byDay: ObservatoryAppData["by_day"] }): React.ReactElement {
  if (byDay.length === 0) {
    return (
      <View style={{ gap: space.sm }}>
        <Text variant="eyebrow" accessibilityRole="header">
          Daily activity
        </Text>
        <Text variant="caption" color="textSecondary">
          No days in this window yet.
        </Text>
      </View>
    );
  }
  const max = Math.max(1, ...byDay.map((day) => day.listings_created));
  return (
    <View style={{ gap: space.sm }}>
      <Text variant="eyebrow" accessibilityRole="header">
        Daily activity · listings created
      </Text>
      <View style={{ gap: space.xs }}>
        {byDay.map((day) => (
          <BarRow key={day.date} label={day.date} value={day.listings_created} max={max} />
        ))}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// `app.bulk` — estate bulk upload, plan Stage 5. Same D1-derived floor as
// every other section above (no `ObservatorySource` wrapper — it cannot be
// unconfigured), and the same "don't render a number for a feature nobody
// turned on" rule `SearchIndexSection` already follows: `enabled: false`
// means `BULK_UPLOAD` is off in this environment — local dev only as of
// 2026-09-08, since it is `"1"` in both preview and production
// (`apps/api/wrangler.toml`).
//
// Five sub-blocks, in the order an operator would actually check them when
// something feels stuck: is anything moving at all (batches), what's
// backed up (drafts), is a submission actually stuck (operations — the age
// is the one number in this whole section worth a second look), is a daily
// ceiling the reason (usage), and finally the windowed funnel a quiet day
// still wants reported.
// ---------------------------------------------------------------------------

/** A small caps label above a group of `StatBadge`s — one down from
 * `variant="eyebrow"`, so five sub-blocks inside one `BulkSection` read as
 * subordinate to its own "Bulk upload" eyebrow rather than five more
 * sections at the same level. */
function SubHeading({ children }: { children: string }): React.ReactElement {
  return (
    <Text variant="label" color="textSecondary" style={{ fontSize: 10, letterSpacing: 0.04 }}>
      {children}
    </Text>
  );
}

function BulkSection({ bulk }: { bulk: ObservatoryBulk }): React.ReactElement {
  if (!bulk.enabled) {
    return (
      <View style={{ gap: space.sm }}>
        <Text variant="eyebrow" accessibilityRole="header">
          Bulk upload
        </Text>
        <Text variant="body">Estate bulk upload is switched off in this environment, so there is nothing to report.</Text>
      </View>
    );
  }

  const { batches, drafts, operations, usage, funnel } = bulk;

  return (
    <View style={{ gap: space.sm }}>
      <Text variant="eyebrow" accessibilityRole="header">
        Bulk upload
      </Text>

      <View style={{ gap: space.xs }}>
        <SubHeading>Batches</SubHeading>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
          <StatBadge label="Draft" value={batches.by_state.draft} />
          <StatBadge label="Submitting" value={batches.by_state.submitting} />
          <StatBadge label="Closed" value={batches.by_state.closed} />
          <StatBadge label="Cancelled" value={batches.by_state.cancelled} />
          <StatBadge label="Active now" value={batches.active} />
          <StatBadge label="Abandoned drafts" value={batches.abandoned_draft} />
        </View>
      </View>

      <View style={{ gap: space.xs }}>
        <SubHeading>Drafts</SubHeading>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
          <StatBadge label="Editing" value={drafts.items_by_state.editing} />
          <StatBadge label="Ready" value={drafts.items_by_state.ready} />
          <StatBadge label="Queued" value={drafts.items_by_state.queued} />
          <StatBadge label="Failed" value={drafts.items_by_state.failed} />
          <StatBadge label="Items outstanding" value={drafts.items_outstanding} />
          <StatBadge label="Photos reserved" value={drafts.photos_reserved} />
          <StatBadge label="Photos stored" value={drafts.photos_stored} />
        </View>
      </View>

      <View style={{ gap: space.xs }}>
        <SubHeading>Operations</SubHeading>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
          <StatBadge label="Queued" value={operations.by_status.queued} />
          <StatBadge label="Running" value={operations.by_status.running} />
          <StatBadge label="Done" value={operations.by_status.done} />
          <StatBadge label="Cancelled" value={operations.by_status.cancelled} />
          <StatBadge label="Active now" value={operations.active} />
          <StatBadge label="Lease recoveries (active)" value={operations.active_stale_lease_recoveries} />
        </View>
        <AgeRow label="Oldest active operation" ms={operations.oldest_active_age_ms} nullLabel="Nothing queued or running" />
      </View>

      <View style={{ gap: space.xs }}>
        <SubHeading>Usage today</SubHeading>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
          <StatBadge label="Owners today" value={usage.owners_today} />
          <StatBadge label="Items used" value={usage.items_used} />
          <StatBadge label="Photos used" value={usage.photos_used} />
          <StatBadge label="Suggestions used" value={usage.suggestions_used} />
          <StatBadge label="Owners at a limit" value={usage.owners_at_limit} />
        </View>
      </View>

      <View style={{ gap: space.xs }}>
        <SubHeading>{`Funnel · last ${funnel.window_days} ${funnel.window_days === 1 ? "day" : "days"}`}</SubHeading>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
          <StatBadge label="Batches started" value={funnel.batches_started} />
          <StatBadge label="Items submitted" value={funnel.items_submitted} />
          <StatBadge label="Items approved" value={funnel.items_approved} />
        </View>
        <View style={{ gap: space.xxs }}>
          <View accessibilityRole="text" accessibilityLabel={`Orphan bytes: ${formatBytes(funnel.orphan_bytes)}`} style={{ flexDirection: "row", gap: space.sm }}>
            <Text variant="caption" color="textSecondary" style={{ width: 168 }}>
              Orphan bytes
            </Text>
            <Text variant="caption">{formatBytes(funnel.orphan_bytes)}</Text>
          </View>
          <AgeRow
            label="Moderation latency, ordinary"
            ms={funnel.moderation_latency_ordinary_median_ms}
            nullLabel="No decisions yet"
          />
          <AgeRow label="Moderation latency, bulk" ms={funnel.moderation_latency_bulk_median_ms} nullLabel="No decisions yet" />
        </View>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// The three-state `ObservatorySource` wrapper. One generic renderer so every
// caller draws "unconfigured" and "error" identically — a dashed ink box
// with the word NOT CONFIGURED for the first, a solid danger box with the
// word ERROR for the second — and neither one is a chance for a stray
// `source.data ?? 0` to sneak back in.
// ---------------------------------------------------------------------------

function SourceSection<T>({
  title,
  source,
  renderOk,
}: {
  title: string;
  source: ObservatorySource<T>;
  renderOk: (data: T) => React.ReactElement;
}): React.ReactElement {
  const colors = useColors();

  if (source.state === "unconfigured") {
    return (
      <View style={{ gap: space.sm }}>
        <Text variant="eyebrow" accessibilityRole="header">
          {title}
        </Text>
        <View
          accessibilityRole="text"
          accessibilityLabel={`${title}: not configured — ${source.reason}`}
          style={{ borderWidth: 2, borderStyle: "dashed", borderColor: colors.ink, backgroundColor: colors.surface, padding: space.md, gap: space.xxs }}
        >
          <Text variant="label" color="textSecondary" style={{ fontSize: 10 }}>
            NOT CONFIGURED
          </Text>
          <Text variant="caption" color="textSecondary">
            {source.reason}
          </Text>
        </View>
      </View>
    );
  }

  if (source.state === "error") {
    return (
      <View style={{ gap: space.sm }}>
        <Text variant="eyebrow" accessibilityRole="header">
          {title}
        </Text>
        <View
          accessibilityRole="text"
          accessibilityLabel={`${title}: error — ${source.error}`}
          style={{ borderWidth: 2, borderColor: colors.danger, backgroundColor: colors.surface, padding: space.md, gap: space.xxs }}
        >
          <Text variant="label" color="dangerText" style={{ fontSize: 10 }}>
            ERROR
          </Text>
          <Text variant="caption" color="dangerText">
            {source.error}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={{ gap: space.sm }}>
      <Text variant="eyebrow" accessibilityRole="header">
        {title}
      </Text>
      {renderOk(source.data)}
    </View>
  );
}

function EdgeSection({ edge }: { edge: ObservatoryEdge }): React.ReactElement {
  const max = Math.max(1, ...edge.by_day.map((day) => day.requests));
  return (
    <View style={{ gap: space.sm }}>
      <Text variant="caption" color="textSecondary">{`Last ${edge.window_days} ${edge.window_days === 1 ? "day" : "days"} · ${edge.script}`}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
        <StatBadge label="Requests" value={edge.totals.requests} />
        <StatBadge label="Errors" value={edge.totals.errors} />
        <StatBadge label="Subrequests" value={edge.totals.subrequests} />
      </View>
      {edge.by_day.length > 0 ? (
        <View style={{ gap: space.xs }}>
          {edge.by_day.map((day) => (
            <BarRow key={day.date} label={day.date} value={day.requests} max={max} />
          ))}
        </View>
      ) : null}
      <Text variant="caption" color="textSecondary">
        {`CPU p50 ${edge.cpu_time_p50_us ?? "—"}µs · p99 ${edge.cpu_time_p99_us ?? "—"}µs`}
      </Text>
    </View>
  );
}

/** `logs.window_days` is reported honestly by the API and may be *shorter*
 * than the panel's own selected window — Workers Logs on the Free plan only
 * retains 3 days, per `ObservatoryLogs`'s doc comment — so this states its
 * own coverage rather than letting the reader assume it matches the window
 * selector above it. */
function LogsSection({ logs, nowMs }: { logs: ObservatoryLogs; nowMs: number }): React.ReactElement {
  // Defensive, not corrective: the contract already promises "most recent
  // first", but a render-time sort costs nothing at this scale (this is a
  // capped sample, not an archive — see `ObservatoryLogs.events`'s doc
  // comment) and means this section's own contract to the reader doesn't
  // depend on the API never regressing its ordering.
  const events = [...logs.events].sort((a, b) => b.ts - a.ts);
  return (
    <View style={{ gap: space.sm }}>
      <Text variant="caption" color="textSecondary">{`Last ${logs.window_days} ${logs.window_days === 1 ? "day" : "days"}`}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
        <StatBadge label="Errors" value={logs.counts.error} />
        <StatBadge label="Warnings" value={logs.counts.warning} />
      </View>
      {events.length === 0 ? (
        <Text variant="caption" color="textSecondary">
          No log lines in this window.
        </Text>
      ) : (
        <View style={{ gap: space.sm }}>
          {events.map((event, index) => (
            <LogEventRow key={`${event.ts}-${index}`} event={event} nowMs={nowMs} />
          ))}
        </View>
      )}
    </View>
  );
}

function LogEventRow({ event, nowMs }: { event: ObservatoryLogEvent; nowMs: number }): React.ReactElement {
  const colors = useColors();
  const isError = event.level === "error";
  const scope = event.service !== null ? ` in ${event.service}` : "";
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={`${formatAgo(event.ts, nowMs)}, ${event.level}${scope}: ${event.message}`}
      style={{ flexDirection: "row", gap: space.sm, borderLeftWidth: 3, borderLeftColor: isError ? colors.danger : colors.ink, paddingLeft: space.sm }}
    >
      <View style={{ width: 72 }}>
        <Text variant="caption" color={isError ? "dangerText" : "textSecondary"} style={{ textTransform: "uppercase" }}>
          {event.level}
        </Text>
        <Text variant="caption" color="textTertiary">
          {formatAgo(event.ts, nowMs)}
        </Text>
      </View>
      <View style={{ flexShrink: 1, gap: 2 }}>
        <Text variant="caption">{event.message}</Text>
        {event.service !== null ? (
          <Text variant="caption" color="textTertiary">
            {event.service}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// The window selector — `OBSERVATORY_WINDOWS`, as a tablist of `Chip`s in
// the same idiom `app/admin.tsx`'s own status-tab row already uses.
// ---------------------------------------------------------------------------

function WindowSelector({ value, onChange }: { value: ObservatoryWindow; onChange: (next: ObservatoryWindow) => void }): React.ReactElement {
  return (
    <View
      accessibilityRole="tablist"
      aria-label="Observatory window"
      style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}
    >
      {OBSERVATORY_WINDOWS.map((n) => (
        <Chip key={n} role="tab" label={n === 1 ? "1 day" : `${n} days`} selected={value === n} onPress={() => onChange(n)} />
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// The panel itself. Owns its own fetch: `app/admin.tsx` only renders this
// component once the Observatory section is selected (see that file's
// `activeSection` state), so simply not mounting it is what keeps the
// default queue view from paying for a request it never asked for — no
// separate "loaded" flag needed here the way `queueReducer.ts` needs one for
// the queue's four tabs, because this only ever has one instance to load.
// ---------------------------------------------------------------------------

export type ObservatoryProps = {
  token: string;
  /** Fired on any 401 from `getObservatory` — the caller's existing
   * `handleSessionExpired` (clears the token, drops back to the gate, shows
   * a toast). Deliberately not a second auth path: this panel never touches
   * `src/lib/adminToken.ts` itself, same rule `src/api/admin.ts`'s file
   * header states for every other admin call. */
  onSessionExpired: () => void;
};

/** `data` and the moment it was fetched, set together so the two can never
 * observe different renders of each other. Kept as one state value rather
 * than two siblings (`data`/`fetchedAt`) specifically so nothing downstream
 * — `LogsSection`'s `nowMs` in particular — can end up rendering a `data`
 * with no matching `fetchedAt`, which would force a fallback `Date.now()`
 * call inside the render body. `StatsStrip.tsx`'s own `healthAsOf` doc
 * comment explains why that call has to happen in the fetch callback
 * instead: React's rules on purity don't allow an impure read inside render. */
type Snapshot = { data: ObservatoryData; fetchedAt: number; windowDays: ObservatoryWindow };

/** A failed load, tagged with the window it was for — see `loading` below for
 * why both pieces of state carry the window rather than being bare values. */
type Failure = { message: string; windowDays: ObservatoryWindow };

export function Observatory({ token, onSessionExpired }: ObservatoryProps): React.ReactElement {
  const [windowDays, setWindowDays] = React.useState<ObservatoryWindow>(7);
  const [snapshot, setSnapshot] = React.useState<Snapshot | null>(null);
  const [failure, setFailure] = React.useState<Failure | null>(null);

  // `loading` and `error` are *derived*, not stored, and that is a
  // correctness fix rather than a tidy-up. Storing them meant the effect had
  // to open with a synchronous `setLoading(true); setError(null)` on every
  // window change — a state write during the effect pass, which React
  // schedules an extra render for and which the lint rule
  // `react-hooks/set-state-in-effect` flags for exactly that reason.
  //
  // Tagging each piece of state with the window it belongs to says the same
  // thing without the extra render: we are loading whenever neither the
  // snapshot we hold nor the failure we hold is about the window currently
  // selected, and an error is only worth showing while it still describes
  // that window. Switching from 7 days to 30 makes both mismatch, so the
  // spinner appears on the same render as the new selection, and a stale
  // error from the old window clears itself rather than needing to be reset.
  //
  // Keyed on the window alone and not on the token: `admin.tsx` only renders
  // this panel while a token is held, and a 401 clears the token and drops
  // back to the gate, so this component cannot survive a token change and
  // hold a snapshot that wrongly looks current.
  const loading = snapshot?.windowDays !== windowDays && failure?.windowDays !== windowDays;
  const error = failure?.windowDays === windowDays ? failure.message : null;

  // The `cancelled` flag (not just `controller.abort()`) is the same
  // belt-and-suspenders pattern `src/ui/theme.tsx`'s own preference-load
  // effect uses: `apiFetch` catches every `fetch()` rejection — including an
  // abort — and rethrows it as a generic `ApiError`, so an aborted request
  // would otherwise still reach the `.catch` below and flash a false
  // "couldn't load" error the instant a window switch fires the next
  // request. `cancelled` is checked before every state write, so a
  // superseded request's result (success or failure) is simply dropped.
  React.useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    getObservatory(token, { windowDays, signal: controller.signal })
      .then((result) => {
        if (cancelled) return;
        setSnapshot({ data: result, fetchedAt: Date.now(), windowDays });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          onSessionExpired();
          return;
        }
        setFailure({ message: err instanceof ApiError ? err.message : "Couldn't load the observatory.", windowDays });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [token, windowDays, onSessionExpired]);

  return (
    <View style={{ gap: sectionRhythm.tight }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: space.md }}>
        <WindowSelector value={windowDays} onChange={setWindowDays} />
        {loading && snapshot !== null ? (
          <Text variant="caption" color="textSecondary">
            Refreshing…
          </Text>
        ) : null}
      </View>

      {error !== null ? (
        <Text variant="body" color="dangerText">
          {error}
        </Text>
      ) : null}

      {snapshot === null ? (
        loading ? (
          <View style={{ gap: space.md }}>
            <Skeleton height={120} />
            <Skeleton height={120} />
            <Skeleton height={200} />
          </View>
        ) : null
      ) : (
        <View style={{ gap: sectionRhythm.tight }}>
          <NeedsAttentionSection alerts={snapshot.data.report.needs_attention} />
          <ModerationSection moderation={snapshot.data.app.moderation} />
          <SearchIndexSection searchIndex={snapshot.data.app.search_index} />
          <FunnelSection funnel={snapshot.data.app.funnel} />
          <AppSeriesSection byDay={snapshot.data.app.by_day} />
          <BulkSection bulk={snapshot.data.app.bulk} />
          <SourceSection title="Edge traffic" source={snapshot.data.edge} renderOk={(edge) => <EdgeSection edge={edge} />} />
          <SourceSection
            title="Worker logs"
            source={snapshot.data.logs}
            renderOk={(logs) => <LogsSection logs={logs} nowMs={snapshot.fetchedAt} />}
          />
        </View>
      )}
    </View>
  );
}

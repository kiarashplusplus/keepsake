/**
 * `GET /api/admin/stats` as a strip of stamped labels on an index card — a
 * count and a mono caption under it, ink-outlined like a rubber-stamped
 * ledger entry rather than a rounded "metric card." No chart, no color
 * coding beyond what the rest of the system already uses: this is a glance,
 * not a dashboard.
 *
 * The cron row underneath reuses the exact same stamped-badge language for
 * `GET /api/admin/health`'s `cron_last_run` — the one other "is something
 * quietly broken" signal Kiarash needs at a glance. It borrows the same
 * ink/danger border switch `Input`/`TextArea` already use for a field in
 * error, rather than inventing a new color meaning.
 *
 * The reports row under *that* is issue #89 and is the same idiom again,
 * deliberately: three strangers can hide a live listing between them, and
 * until now the only trace was a Workers Logs line nothing reads. Same
 * badge, same ink/danger switch, same ", needs attention" suffix on the
 * accessibility label as a stale cron — a moderator should not have to
 * learn a second visual language for the second thing that can quietly
 * need them.
 */
import * as React from "react";
import { View, type ViewStyle } from "react-native";
import { space } from "@keepsake/tokens/spacing";
import { LISTING_STATUSES } from "@keepsake/contracts/listing";
import type { AdminHealth, AdminStats } from "@keepsake/contracts/admin";
import { Card } from "@/ui/Surface";
import { Eyebrow } from "@/ui/Eyebrow";
import { Text } from "@/ui/Text";
import { Skeleton } from "@/ui/Skeleton";
import { useColors } from "@/ui/theme";
import { useViewport } from "@/ui/viewport";

const STATUS_LABELS: Record<(typeof LISTING_STATUSES)[number], string> = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  needs_review: "Needs review",
  hidden: "Hidden",
  given: "Given",
  withdrawn: "Withdrawn",
};

/** Job names as shown to Kiarash, in the same order `CRON_JOB_NAMES` in
 * `apps/api/src/routes/admin.ts` reports them. */
const CRON_JOB_LABELS: Record<string, string> = {
  moderationRetry: "Moderation retry",
  orphanSweep: "Orphan sweep",
};

/**
 * Mirrors `CRON_STALE_AFTER_MS` in `apps/api/src/routes/admin.ts` exactly —
 * duplicated rather than shipped over the wire because `AdminHealth.ok` is
 * deliberately one verdict for the whole backend (postal codes included),
 * not a per-cron one, and this strip needs to know *which* heartbeat is
 * stale, not just whether something, somewhere, is.
 */
const CRON_STALE_AFTER_MS: Record<string, number> = {
  moderationRetry: 30 * 60 * 1000,
  orphanSweep: 26 * 60 * 60 * 1000,
};
const DEFAULT_STALE_AFTER_MS = 26 * 60 * 60 * 1000;

export function isCronStale(name: string, lastRunMs: number | null, nowMs: number): boolean {
  if (lastRunMs === null) return true;
  const staleAfter = CRON_STALE_AFTER_MS[name] ?? DEFAULT_STALE_AFTER_MS;
  return nowMs - lastRunMs > staleAfter;
}

/** "4 min ago" / "2 hr ago" / "3 days ago" / "just now" — coarse on purpose,
 * this is a glance at how long something has been sitting, not a precise
 * clock. Shared by the cron row and the report-pressure row below so the two
 * never disagree about what "2 hr ago" means. */
export function formatAgo(timestampMs: number, nowMs: number): string {
  const diffMs = Math.max(0, nowMs - timestampMs);
  const minutes = Math.floor(diffMs / (60 * 1000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/** `formatAgo` plus the one case only a heartbeat has: a cron that has never
 * written one at all. */
export function formatCronLastRun(lastRunMs: number | null, nowMs: number): string {
  if (lastRunMs === null) return "never";
  return formatAgo(lastRunMs, nowMs);
}

/**
 * The one stamped-tile frame all three badges below share. `minWidth` keeps
 * a tile from collapsing around a single digit; `flexBasis` is the viewport
 * switch's `tileBasis` — a third of the row on a phone, intrinsic above it
 * (#363: sized by content alone, eleven tiles fell into rows of 3, 2, 3, 2
 * and 1 at 390px, since "Needs review" and "Email failures" each pushed
 * their row to two). The labels wrap to a second line inside the fixed
 * third; `textAlign: "center"` on each of them is what makes that read.
 */
function useTileFrame(borderColor: string): ViewStyle {
  const colors = useColors();
  const vp = useViewport();
  return {
    borderWidth: 2,
    borderColor,
    backgroundColor: colors.surface,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    minWidth: 92,
    flexBasis: vp.tileBasis,
    alignItems: "center",
    gap: space.xxs,
  };
}

function StatBadge({ label, value }: { label: string; value: number }): React.ReactElement {
  const colors = useColors();
  const frame = useTileFrame(colors.ink);
  return (
    <View style={frame}>
      <Text variant="displayMd">{value}</Text>
      <Text variant="label" color="textSecondary" style={{ fontSize: 10, textAlign: "center" }}>
        {label}
      </Text>
    </View>
  );
}

function CronBadge({ name, lastRunMs, nowMs }: { name: string; lastRunMs: number | null; nowMs: number }): React.ReactElement {
  const colors = useColors();
  const stale = isCronStale(name, lastRunMs, nowMs);
  const label = CRON_JOB_LABELS[name] ?? name;
  const frame = useTileFrame(stale ? colors.danger : colors.ink);
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={`${label}: last run ${formatCronLastRun(lastRunMs, nowMs)}${stale ? ", needs attention" : ""}`}
      style={frame}
    >
      <Text variant="caption" color={stale ? "dangerText" : "ink"}>
        {formatCronLastRun(lastRunMs, nowMs)}
      </Text>
      <Text variant="label" color="textSecondary" style={{ fontSize: 10, textAlign: "center" }}>
        {label}
      </Text>
    </View>
  );
}

/**
 * Issue #89. Same stamped badge as `CronBadge`, same ink/danger border, same
 * ", needs attention" suffix — the only difference is what it counts. Split
 * from `StatBadge` rather than adding an `attention` prop to it because a
 * plain stat badge should never be able to render red by accident; the two
 * carry different meanings and the compiler now says so.
 */
function AlertBadge({ label, value, attention }: { label: string; value: number; attention: boolean }): React.ReactElement {
  const colors = useColors();
  const frame = useTileFrame(attention ? colors.danger : colors.ink);
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={`${label}: ${value}${attention ? ", needs attention" : ""}`}
      style={frame}
    >
      <Text variant="displayMd" color={attention ? "dangerText" : "ink"}>
        {value}
      </Text>
      <Text variant="label" color="textSecondary" style={{ fontSize: 10, textAlign: "center" }}>
        {label}
      </Text>
    </View>
  );
}

/**
 * `GET /api/admin/health`'s `report_pressure` — issue #89: at
 * `REPORT_AUTOHIDE_THRESHOLD` reports a live listing hides itself, and
 * nothing told anyone. `/health` is about the Worker, so it stayed green
 * throughout; the auto-hide's `captureMessage` goes to Workers Logs, which
 * has no Tail Worker or Logpush reading it (docs/runbooks/incident.md).
 *
 * "Awaiting review" is the count that matters and the one that turns red:
 * it is listings the threshold took down that no admin has acted on since,
 * so it clears itself the moment Kiarash restores, rejects or confirms one
 * — a badge that stays red until someone does something, rather than a
 * notification that scrolls away unread. "One away" is a heads-up and stays
 * ink: nothing has been taken down yet.
 *
 * The ids underneath are plain text in the same idiom as the email-failure
 * breakdown above, and for the same reason: the number of entries varies, so
 * a row of boxes could grow unbounded. They are listing ULIDs, which is what
 * the hidden queue is keyed by.
 */
function ReportPressureSection({
  pressure,
  nowMs,
}: {
  pressure: AdminHealth["report_pressure"];
  nowMs: number;
}): React.ReactElement {
  const awaiting = pressure.autohidden_awaiting_review;
  return (
    <View style={{ gap: space.sm }}>
      <Eyebrow>{`Reports · auto-hides at ${pressure.threshold}`}</Eyebrow>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
        <AlertBadge label="Auto-hidden, unreviewed" value={awaiting.length} attention={awaiting.length > 0} />
        <AlertBadge label="One report away" value={pressure.near_threshold.length} attention={false} />
      </View>
      {awaiting.length > 0 ? (
        <View style={{ gap: space.xxs }}>
          {awaiting.map((entry) => (
            <View key={entry.listing_id} style={{ flexDirection: "row", gap: space.sm }}>
              <Text variant="caption" color="dangerText">
                {formatAgo(entry.autohidden_at, nowMs)}
              </Text>
              <Text variant="caption" color="textSecondary">
                {`${entry.listing_id} · ${entry.report_count} reports`}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export type StatsStripProps = {
  stats: AdminStats | null;
  health: AdminHealth | null;
  /**
   * `Date.now()` at the moment `health` was fetched, captured by the caller
   * (`apps/web/app/admin.tsx`, right next to `setHealth`) rather than read
   * here: a component's render body isn't allowed to call an impure
   * function like `Date.now()` itself (see React's rules on purity), and
   * this is a snapshot for a glance, not a ticking clock, so it only needs
   * to be as fresh as `health` already is.
   */
  healthAsOf: number | null;
};

export function StatsStrip({ stats, health, healthAsOf }: StatsStripProps): React.ReactElement {
  if (stats === null) {
    return (
      <Card style={{ gap: space.md }}>
        <Eyebrow>Today</Eyebrow>
        <Skeleton height={80} />
      </Card>
    );
  }

  return (
    <Card style={{ gap: space.md }}>
      <Eyebrow>Today</Eyebrow>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
        {LISTING_STATUSES.map((status) => (
          <StatBadge key={status} label={STATUS_LABELS[status]} value={stats.listings_by_status[status]} />
        ))}
        <StatBadge label="Requests" value={stats.requests_today} />
        <StatBadge label="Email failures" value={stats.email_failures_today} />
        <StatBadge label="AI text used" value={stats.ai_budget_used_today.mod_text} />
        <StatBadge label="AI image used" value={stats.ai_budget_used_today.mod_image} />
      </View>

      <Eyebrow>Crons</Eyebrow>
      {health === null || healthAsOf === null ? (
        <Skeleton height={64} width={200} />
      ) : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
          {Object.keys(CRON_JOB_LABELS).map((name) => (
            <CronBadge key={name} name={name} lastRunMs={health.cron_last_run[name] ?? null} nowMs={healthAsOf} />
          ))}
        </View>
      )}

      {health === null || healthAsOf === null ? null : (
        <ReportPressureSection pressure={health.report_pressure} nowMs={healthAsOf} />
      )}

      <EmailEventsSection stats={stats.email_events_7d} />
    </Card>
  );
}

/**
 * A domain whose sends are failing *entirely* is not a bounce, it is a
 * policy: the Cloudflare binding refusing every unverified destination looks
 * exactly like a healthy system from the inside (issue #6). One failure in
 * forty is noise; forty in forty is the launch blocker. This is the line
 * between them, and the only reason `attempted` is shown at all.
 *
 * `attempted >= 2` keeps a single isolated failure — which is 1-of-1, and so
 * technically "all of them" — from borrowing the same red as a systematic
 * refusal. The per-reason list above already accounts for that one.
 */
export function isSystematicDomainFailure(entry: { attempted: number; failed: number }): boolean {
  return entry.attempted >= 2 && entry.failed === entry.attempted;
}

/**
 * `email_events` grouped by outcome, `window_days` wide — issue #6: there is
 * no bounce webhook or complaint feedback loop, so this is the only place a
 * real delivery problem would ever surface rather than silently
 * accumulating. Same stamped-badge language as the rest of the strip for the
 * ok/failed counts; the two breakdowns underneath are plain text rather than
 * more rows of badges, since the number of distinct reasons and domains
 * varies and a bad week could otherwise produce an unbounded row of boxes.
 *
 * Two breakdowns, not one, because either alone hides the failure this issue
 * is about. By reason: "3 × send_failed" reads the same whether three
 * strangers mistyped their address or the binding is refusing everything it
 * is handed. By domain, with `attempted` next to `failed`: "1/40 gmail.com"
 * and "40/40 gmail.com" finally look different — and the second one turns
 * red, the same ink/danger switch a stale cron and an unreviewed auto-hide
 * already use. No new color meaning, no new component vocabulary.
 */
function EmailEventsSection({ stats }: { stats: AdminStats["email_events_7d"] }): React.ReactElement {
  return (
    <View style={{ gap: space.sm }}>
      <Eyebrow>{`Email, last ${stats.window_days} days`}</Eyebrow>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
        <StatBadge label="Sent" value={stats.ok} />
        <StatBadge label="Failed" value={stats.failed} />
      </View>
      {stats.by_error.length > 0 ? (
        <View style={{ gap: space.xxs }}>
          {stats.by_error.map((entry) => (
            <View key={entry.error} style={{ flexDirection: "row", gap: space.sm }}>
              <Text variant="caption" color="dangerText">
                {entry.count}×
              </Text>
              <Text variant="caption" color="textSecondary">
                {entry.error}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {stats.failures_by_domain.length > 0 ? (
        <View style={{ gap: space.xxs }}>
          <Eyebrow>Failing recipients, by domain</Eyebrow>
          {stats.failures_by_domain.map((entry) => {
            const systematic = isSystematicDomainFailure(entry);
            return (
              <View
                key={entry.domain}
                accessibilityRole="text"
                accessibilityLabel={`${entry.domain}: ${entry.failed} of ${entry.attempted} failed, ${entry.top_reason}${
                  systematic ? ", every send refused, needs attention" : ""
                }`}
                style={{ flexDirection: "row", gap: space.sm }}
              >
                <Text variant="caption" color="dangerText">
                  {`${entry.failed}/${entry.attempted}`}
                </Text>
                <Text variant="caption" color={systematic ? "dangerText" : "textSecondary"}>
                  {`${entry.domain} · ${entry.top_reason}`}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

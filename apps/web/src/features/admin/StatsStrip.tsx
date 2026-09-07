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
 */
import * as React from "react";
import { View } from "react-native";
import { space } from "@keepsake/tokens/spacing";
import { LISTING_STATUSES } from "@keepsake/contracts/listing";
import type { AdminHealth, AdminStats } from "@keepsake/contracts/admin";
import { Card } from "@/ui/Surface";
import { Eyebrow } from "@/ui/Eyebrow";
import { Text } from "@/ui/Text";
import { Skeleton } from "@/ui/Skeleton";
import { useColors } from "@/ui/theme";

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

/** "4 min ago" / "2 hr ago" / "3 days ago" / "just now" / "never" — coarse
 * on purpose, this is a glance at whether a cron is alive, not a precise
 * clock. */
export function formatCronLastRun(lastRunMs: number | null, nowMs: number): string {
  if (lastRunMs === null) return "never";
  const diffMs = Math.max(0, nowMs - lastRunMs);
  const minutes = Math.floor(diffMs / (60 * 1000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

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

function CronBadge({ name, lastRunMs, nowMs }: { name: string; lastRunMs: number | null; nowMs: number }): React.ReactElement {
  const colors = useColors();
  const stale = isCronStale(name, lastRunMs, nowMs);
  const label = CRON_JOB_LABELS[name] ?? name;
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={`${label}: last run ${formatCronLastRun(lastRunMs, nowMs)}${stale ? ", needs attention" : ""}`}
      style={{
        borderWidth: 2,
        borderColor: stale ? colors.danger : colors.ink,
        backgroundColor: colors.surface,
        paddingVertical: space.sm,
        paddingHorizontal: space.md,
        minWidth: 92,
        alignItems: "center",
        gap: space.xxs,
      }}
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
    </Card>
  );
}

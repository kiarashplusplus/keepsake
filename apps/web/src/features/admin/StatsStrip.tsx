/**
 * `GET /api/admin/stats` as a strip of stamped labels on an index card — a
 * count and a mono caption under it, ink-outlined like a rubber-stamped
 * ledger entry rather than a rounded "metric card." No chart, no color
 * coding beyond what the rest of the system already uses: this is a glance,
 * not a dashboard.
 */
import * as React from "react";
import { View } from "react-native";
import { space } from "@keepsake/tokens/spacing";
import { LISTING_STATUSES } from "@keepsake/contracts/listing";
import type { AdminStats } from "@keepsake/contracts/admin";
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

export function StatsStrip({ stats }: { stats: AdminStats | null }): React.ReactElement {
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
    </Card>
  );
}

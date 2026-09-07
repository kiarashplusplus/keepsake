import * as React from "react";
import { render } from "@testing-library/react-native";
import { LISTING_STATUSES } from "@keepsake/contracts/listing";
import type { AdminHealth, AdminStats } from "@keepsake/contracts/admin";
import { ThemeProvider } from "@/ui/theme";
import { StatsStrip, formatCronLastRun, isCronStale } from "@/features/admin/StatsStrip";

const STATS: AdminStats = {
  listings_by_status: Object.fromEntries(LISTING_STATUSES.map((status) => [status, 0])) as AdminStats["listings_by_status"],
  requests_today: 0,
  email_failures_today: 0,
  ai_budget_used_today: { mod_text: 0, mod_image: 0 },
};

const NOW = Date.parse("2026-09-07T12:00:00.000Z");

describe("formatCronLastRun", () => {
  it("shows 'never' for a cron that has not written its heartbeat", () => {
    expect(formatCronLastRun(null, NOW)).toBe("never");
  });

  it("shows minutes for a run under an hour old", () => {
    expect(formatCronLastRun(NOW - 4 * 60 * 1000, NOW)).toBe("4 min ago");
  });

  it("shows hours for a run under a day old", () => {
    expect(formatCronLastRun(NOW - 2 * 60 * 60 * 1000, NOW)).toBe("2 hr ago");
  });
});

describe("isCronStale", () => {
  it("treats null (never run) as stale", () => {
    expect(isCronStale("moderationRetry", null, NOW)).toBe(true);
  });

  it("is stale past moderationRetry's 30-minute window", () => {
    expect(isCronStale("moderationRetry", NOW - 31 * 60 * 1000, NOW)).toBe(true);
  });

  it("is not stale within moderationRetry's 30-minute window", () => {
    expect(isCronStale("moderationRetry", NOW - 10 * 60 * 1000, NOW)).toBe(false);
  });

  it("is not stale for orphanSweep at 2 hours (its window is 26 hours)", () => {
    expect(isCronStale("orphanSweep", NOW - 2 * 60 * 60 * 1000, NOW)).toBe(false);
  });
});

// `healthAsOf` is passed explicitly (the caller's `Date.now()` snapshot at
// fetch time — see `StatsStripProps`'s doc comment) rather than mocking the
// global clock: the component itself never reads `Date.now()`.
function renderStrip(health: AdminHealth | null, healthAsOf: number | null): ReturnType<typeof render> {
  return render(
    <ThemeProvider mode="light">
      <StatsStrip stats={STATS} health={health} healthAsOf={healthAsOf} />
    </ThemeProvider>,
  );
}

describe("StatsStrip", () => {
  it("renders a stale cron with an attention state and its relative last-run time", () => {
    const health: AdminHealth = {
      ok: false,
      postal_codes_count: 5,
      cron_last_run: {
        moderationRetry: NOW - 45 * 60 * 1000, // stale: past the 30-min window
        orphanSweep: NOW - 60 * 60 * 1000, // fresh: well inside the 26-hr window
      },
    };
    const { UNSAFE_getByProps } = renderStrip(health, NOW);
    const badge = UNSAFE_getByProps({ accessibilityLabel: "Moderation retry: last run 45 min ago, needs attention" });
    expect(badge).toBeTruthy();
  });

  it("does not mark a fresh cron as needing attention", () => {
    const health: AdminHealth = {
      ok: true,
      postal_codes_count: 5,
      cron_last_run: {
        moderationRetry: NOW - 2 * 60 * 1000,
        orphanSweep: NOW - 60 * 60 * 1000,
      },
    };
    const { UNSAFE_getByProps, queryAllByLabelText } = renderStrip(health, NOW);
    const badge = UNSAFE_getByProps({ accessibilityLabel: "Moderation retry: last run 2 min ago" });
    expect(badge).toBeTruthy();
    expect(queryAllByLabelText(/needs attention/)).toHaveLength(0);
  });

  it("shows 'never' with an attention state when a cron has no heartbeat at all", () => {
    const health: AdminHealth = {
      ok: false,
      postal_codes_count: 5,
      cron_last_run: { moderationRetry: null, orphanSweep: NOW - 60 * 60 * 1000 },
    };
    const { UNSAFE_getByProps } = renderStrip(health, NOW);
    const badge = UNSAFE_getByProps({ accessibilityLabel: "Moderation retry: last run never, needs attention" });
    expect(badge).toBeTruthy();
  });

  it("renders a skeleton for the cron row while health hasn't loaded yet", () => {
    const { toJSON } = renderStrip(null, null);
    // No cron badge accessibility labels should be present before `health`
    // arrives — nothing to falsely reassure or alarm Kiarash with.
    expect(JSON.stringify(toJSON())).not.toContain("last run");
  });
});

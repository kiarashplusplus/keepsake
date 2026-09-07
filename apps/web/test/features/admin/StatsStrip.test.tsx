import * as React from "react";
import { render } from "@testing-library/react-native";
import { LISTING_STATUSES } from "@keepsake/contracts/listing";
import type { AdminHealth, AdminStats } from "@keepsake/contracts/admin";
import { ThemeProvider } from "@/ui/theme";
import { StatsStrip, formatAgo, formatCronLastRun, isCronStale } from "@/features/admin/StatsStrip";

const STATS: AdminStats = {
  listings_by_status: Object.fromEntries(LISTING_STATUSES.map((status) => [status, 0])) as AdminStats["listings_by_status"],
  requests_today: 0,
  email_failures_today: 0,
  ai_budget_used_today: { mod_text: 0, mod_image: 0 },
  email_events_7d: { window_days: 7, total: 0, ok: 0, failed: 0, by_error: [] },
};

const NOW = Date.parse("2026-09-07T12:00:00.000Z");

/** No listing under report pressure — the state every pre-#89 fixture
 * implicitly assumed. Spread over, not edited, by the tests that care. */
const NO_REPORT_PRESSURE: AdminHealth["report_pressure"] = {
  threshold: 3,
  autohidden_awaiting_review: [],
  near_threshold: [],
};

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

describe("formatAgo", () => {
  it("shows 'just now' under a minute", () => {
    expect(formatAgo(NOW - 20 * 1000, NOW)).toBe("just now");
  });

  it("shows days for anything older than a day", () => {
    expect(formatAgo(NOW - 3 * 24 * 60 * 60 * 1000, NOW)).toBe("3 days ago");
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
      report_pressure: NO_REPORT_PRESSURE,
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
      report_pressure: NO_REPORT_PRESSURE,
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
      report_pressure: NO_REPORT_PRESSURE,
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

  // Issue #89: three strangers can hide a live listing between them and the
  // only trace was a Workers Logs line nothing reads. These prove the count
  // and the ids actually reach the page — not just the API response shape.
  it("renders an auto-hidden listing with an attention state, its age and its id", () => {
    const health: AdminHealth = {
      ok: false,
      postal_codes_count: 5,
      cron_last_run: { moderationRetry: NOW - 2 * 60 * 1000, orphanSweep: NOW - 60 * 60 * 1000 },
      report_pressure: {
        threshold: 3,
        autohidden_awaiting_review: [
          { listing_id: "01JQZ0X0000000000000000001", report_count: 3, autohidden_at: NOW - 3 * 60 * 60 * 1000 },
        ],
        near_threshold: [],
      },
    };
    const { UNSAFE_getByProps, toJSON } = renderStrip(health, NOW);
    expect(UNSAFE_getByProps({ accessibilityLabel: "Auto-hidden, unreviewed: 1, needs attention" })).toBeTruthy();
    const text = JSON.stringify(toJSON());
    expect(text).toContain("01JQZ0X0000000000000000001");
    expect(text).toContain("3 hr ago");
    expect(text).toContain("3 reports");
  });

  it("does not raise an attention state when nothing has been auto-hidden", () => {
    const health: AdminHealth = {
      ok: true,
      postal_codes_count: 5,
      cron_last_run: { moderationRetry: NOW - 2 * 60 * 1000, orphanSweep: NOW - 60 * 60 * 1000 },
      report_pressure: NO_REPORT_PRESSURE,
    };
    const { UNSAFE_getByProps, queryAllByLabelText } = renderStrip(health, NOW);
    expect(UNSAFE_getByProps({ accessibilityLabel: "Auto-hidden, unreviewed: 0" })).toBeTruthy();
    expect(queryAllByLabelText(/needs attention/)).toHaveLength(0);
  });

  // A listing one report away is a heads-up, not a fault: it is still live
  // and there is nothing for an admin to undo yet, so it must not borrow the
  // same red a stale cron or a completed auto-hide uses.
  it("counts listings one report from hiding without raising an attention state", () => {
    const health: AdminHealth = {
      ok: true,
      postal_codes_count: 5,
      cron_last_run: { moderationRetry: NOW - 2 * 60 * 1000, orphanSweep: NOW - 60 * 60 * 1000 },
      report_pressure: {
        threshold: 3,
        autohidden_awaiting_review: [],
        near_threshold: [
          { listing_id: "01JQZ0X0000000000000000002", report_count: 2 },
          { listing_id: "01JQZ0X0000000000000000003", report_count: 2 },
        ],
      },
    };
    const { UNSAFE_getByProps, queryAllByLabelText } = renderStrip(health, NOW);
    expect(UNSAFE_getByProps({ accessibilityLabel: "One report away: 2" })).toBeTruthy();
    // The threshold itself is stated once, on the section heading, rather
    // than repeated into every badge label.
    expect(JSON.stringify(renderStrip(health, NOW).toJSON())).toContain("Reports · auto-hides at 3");
    expect(queryAllByLabelText(/needs attention/)).toHaveLength(0);
  });

  // Issue #6: there is no bounce webhook, so this rolling read of
  // `email_events` is the only place a real delivery problem would ever
  // surface. Proves the breakdown actually reaches the page, not just the
  // API response shape.
  it("shows the 7-day email breakdown, including a per-reason count for failures", () => {
    const statsWithFailures: AdminStats = {
      ...STATS,
      email_events_7d: {
        window_days: 7,
        total: 12,
        ok: 9,
        failed: 3,
        by_error: [
          { error: "blocked_not_allowlisted", count: 2 },
          { error: "send_failed: 550 mailbox unavailable", count: 1 },
        ],
      },
    };
    const { toJSON } = render(
      <ThemeProvider mode="light">
        <StatsStrip stats={statsWithFailures} health={null} healthAsOf={null} />
      </ThemeProvider>,
    );
    const text = JSON.stringify(toJSON());
    expect(text).toContain("Email, last 7 days");
    expect(text).toContain("blocked_not_allowlisted");
    expect(text).toContain("send_failed: 550 mailbox unavailable");
  });
});

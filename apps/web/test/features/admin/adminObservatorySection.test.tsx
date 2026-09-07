import * as React from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import type { AdminHealth, AdminQueueItem, AdminStats } from "@keepsake/contracts/admin";
import { ToastProvider } from "@/ui/Toast";
import { ADMIN_TOKEN_STORAGE_KEY } from "@/lib/adminToken";
import { getAdminHealth, getAdminQueue, getAdminStats } from "@/api/admin";
import { getObservatory } from "@/api/observatory";
import AdminPage from "../../../app/admin";

/**
 * `app/admin.tsx` mounts `<Observatory>` only once its section tab is
 * picked (see that file's `activeSection` state and `Observatory.tsx`'s own
 * file header) — the mechanism the task relies on to keep the queue, the
 * default view, from paying for a request it never asked for. These tests
 * are the one place that mechanism is actually exercised end to end, rather
 * than trusted from reading the source: `Observatory.test.tsx` renders the
 * panel directly and can't see whether `admin.tsx` ever mounts it lazily.
 */

jest.mock("@/api/admin", () => ({
  getAdminHealth: jest.fn(),
  getAdminQueue: jest.fn(),
  getAdminStats: jest.fn(),
  approveListing: jest.fn(),
  hideListing: jest.fn(),
  restoreListing: jest.fn(),
  rejectListing: jest.fn(),
  banOwner: jest.fn(),
  unbanOwner: jest.fn(),
}));

jest.mock("@/api/observatory", () => ({
  getObservatory: jest.fn(),
}));

const STATS: AdminStats = {
  listings_by_status: { pending: 0, approved: 0, rejected: 0, needs_review: 0, hidden: 0, given: 0, withdrawn: 0 },
  requests_today: 0,
  email_failures_today: 0,
  ai_budget_used_today: { mod_text: 0, mod_image: 0 },
  email_events_7d: { window_days: 7, total: 0, ok: 0, failed: 0, by_error: [], failures_by_domain: [] },
};

const HEALTH: AdminHealth = {
  ok: true,
  postal_codes_count: 1,
  cron_last_run: { moderationRetry: 0, orphanSweep: 0 },
  report_pressure: { threshold: 3, autohidden_awaiting_review: [], near_threshold: [] },
};

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

describe("/admin: Observatory section is not fetched until selected", () => {
  beforeEach(() => {
    window.sessionStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, "e2e-admin");
    jest.mocked(getAdminStats).mockResolvedValue(STATS);
    jest.mocked(getAdminHealth).mockResolvedValue(HEALTH);
    jest.mocked(getAdminQueue).mockResolvedValue({ items: [] as AdminQueueItem[], next_cursor: null });
    jest.mocked(getObservatory).mockResolvedValue({
      generated_at: 0,
      environment: "production",
      commit: "abc1234",
      window_days: 7,
      app: {
        window_days: 7,
        by_day: [],
        funnel: { window_days: 7, photos_uploaded: 0, listings_created: 0, listings_approved: 0, listings_requested: 0, listings_chosen: 0 },
        moderation: { pending: 0, needs_review: 0, oldest_pending_age_ms: null, oldest_needs_review_age_ms: null, median_time_to_decision_ms: null },
        search_index: { enabled: true, approved: 0, unindexed: 0, oldest_unindexed_age_ms: null },
      },
      edge: { state: "unconfigured", reason: "not set" },
      logs: { state: "unconfigured", reason: "not set" },
      report: {
        date: "2026-09-06",
        generated_at: 0,
        environment: "production",
        commit: "abc1234",
        needs_attention: [],
        listings: { created: 0, approved: 0, rejected: 0, pending_now: 0, needs_review_now: 0, oldest_pending_age_ms: null },
        requests: { created: 0, chosen: 0 },
        email: { attempted: 0, failed: 0, top_error: null },
        reports: { autohidden_awaiting_review: 0, near_threshold: 0 },
        budgets: { mod_text: { used: 0, limit: 1 }, mod_image: { used: 0, limit: 1 }, suggest: { used: 0, limit: 1 }, embed: { used: 0, limit: 1 } },
        crons: [],
      },
    });
  });

  afterEach(() => {
    window.sessionStorage.clear();
    jest.clearAllMocks();
  });

  it("defaults to the queue and never calls getObservatory until the tab is picked", async () => {
    const { toJSON, UNSAFE_getAllByProps } = render(
      <ToastProvider>
        <AdminPage />
      </ToastProvider>,
    );
    await act(async () => {
      await flush();
    });

    expect(getObservatory).not.toHaveBeenCalled();
    // The queue's own status tabs are still the default view, unaffected by
    // the new top-level section tabs sitting above them.
    expect(JSON.stringify(toJSON())).toContain("Needs review");

    const observatoryTab = UNSAFE_getAllByProps({ accessibilityLabel: "Observatory" }).at(-1);
    expect(observatoryTab).toBeTruthy();

    await act(async () => {
      if (observatoryTab !== undefined) fireEvent.press(observatoryTab);
      await flush();
    });

    expect(getObservatory).toHaveBeenCalledTimes(1);
  });
});

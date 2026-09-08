import * as React from "react";
import { act, render } from "@testing-library/react-native";
import type { Observatory as ObservatoryData, ObservatoryApp, DailyReport } from "@keepsake/contracts/observatory";
import { ThemeProvider } from "@/ui/theme";
import { ApiError } from "@/api/client";
import { getObservatory } from "@/api/observatory";
import { Observatory, formatDurationMs } from "@/features/admin/Observatory";

// Same shape as `test/app/admin.test.tsx`'s mock of `@/api/admin`: the
// panel's own module is swapped for a jest mock so each test controls
// exactly what the "network" returns, without a real `apiFetch`/`fetch` in
// the loop.
jest.mock("@/api/observatory", () => ({
  getObservatory: jest.fn(),
}));

const NOW = Date.parse("2026-09-07T12:00:00.000Z");

const EMPTY_REPORT: DailyReport = {
  date: "2026-09-06",
  generated_at: NOW,
  environment: "production",
  commit: "abc1234",
  needs_attention: [],
  listings: { created: 0, approved: 0, rejected: 0, pending_now: 0, needs_review_now: 0, oldest_pending_age_ms: null },
  requests: { created: 0, chosen: 0 },
  email: { attempted: 0, failed: 0, top_error: null },
  reports: { autohidden_awaiting_review: 0, near_threshold: 0 },
  budgets: {
    mod_text: { used: 0, limit: 1000 },
    mod_image: { used: 0, limit: 1000 },
    suggest: { used: 0, limit: 1000 },
    embed: { used: 0, limit: 2000 },
  },
  crons: [],
  bulk: null,
};

const EMPTY_APP: ObservatoryApp = {
  window_days: 7,
  by_day: [],
  funnel: {
    window_days: 7,
    photos_uploaded: 0,
    listings_created: 0,
    listings_approved: 0,
    listings_requested: 0,
    listings_chosen: 0,
  },
  moderation: {
    pending: 0,
    needs_review: 0,
    oldest_pending_age_ms: null,
    oldest_needs_review_age_ms: null,
    median_time_to_decision_ms: null,
  },
  search_index: { enabled: true, approved: 0, unindexed: 0, oldest_unindexed_age_ms: null },
  bulk: { enabled: false },
};

/** The floor fixture every test starts from and edits with a spread, same
 * convention `StatsStrip.test.tsx`'s `STATS`/`NO_REPORT_PRESSURE` use — an
 * "all clear, nothing configured" baseline that each test only has to
 * deviate from in the one field it's actually testing. */
function observatory(overrides: Partial<ObservatoryData> = {}): ObservatoryData {
  return {
    generated_at: NOW,
    environment: "production",
    commit: "abc1234",
    window_days: 7,
    app: EMPTY_APP,
    edge: { state: "unconfigured", reason: "CF_OBSERVATORY_TOKEN is not set" },
    logs: { state: "unconfigured", reason: "CF_OBSERVATORY_TOKEN is not set" },
    report: EMPTY_REPORT,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

async function renderObservatory(onSessionExpired: () => void = jest.fn()): Promise<ReturnType<typeof render>> {
  const result = render(
    <ThemeProvider mode="light">
      <Observatory token="e2e-admin" onSessionExpired={onSessionExpired} />
    </ThemeProvider>,
  );
  await act(async () => {
    await flush();
  });
  return result;
}

beforeEach(() => {
  jest.mocked(getObservatory).mockReset();
});

describe("formatDurationMs", () => {
  it("renders hours and minutes for the headline example", () => {
    expect(formatDurationMs(4 * 60 * 60 * 1000 + 12 * 60 * 1000)).toBe("4h 12m");
  });

  it("renders days and hours past a day", () => {
    expect(formatDurationMs(2 * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000)).toBe("2d 3h");
  });

  it("renders minutes under an hour", () => {
    expect(formatDurationMs(45 * 60 * 1000)).toBe("45m");
  });

  it("renders '<1m' for a duration under a minute, distinct from a duration of exactly a minute", () => {
    expect(formatDurationMs(0)).toBe("<1m");
    expect(formatDurationMs(30_000)).toBe("<1m");
    expect(formatDurationMs(60_000)).toBe("1m");
  });
});

describe("Observatory: needs_attention", () => {
  it("renders an explicit all-clear when needs_attention is empty", async () => {
    jest.mocked(getObservatory).mockResolvedValue(observatory());
    const { toJSON } = await renderObservatory();
    const text = JSON.stringify(toJSON());
    expect(text).toContain("All clear");
    expect(text).not.toContain("Critical");
    expect(text).not.toContain("Warning");
  });

  it("renders critical and warning alerts as visually distinct, critical first regardless of API order", async () => {
    jest.mocked(getObservatory).mockResolvedValue(
      observatory({
        report: {
          ...EMPTY_REPORT,
          needs_attention: [
            { severity: "warning", code: "budget_trend", detail: "AI text budget trending toward exhaustion this week." },
            { severity: "critical", code: "cron_stale", detail: "moderationRetry has not run in over an hour." },
          ],
        },
      }),
    );
    const { toJSON } = await renderObservatory();
    const text = JSON.stringify(toJSON());
    expect(text).toContain("CRITICAL");
    expect(text).toContain("moderationRetry has not run in over an hour.");
    expect(text).toContain("WARNING");
    expect(text).toContain("AI text budget trending toward exhaustion this week.");
    // Critical sorts before warning in the rendered order, even though the
    // mock above returned warning first.
    expect(text.indexOf("cron_stale")).toBeLessThan(text.indexOf("budget_trend"));
  });
});

describe("Observatory: moderation latency", () => {
  it("formats a real age as a duration", async () => {
    jest.mocked(getObservatory).mockResolvedValue(
      observatory({
        app: {
          ...EMPTY_APP,
          moderation: { ...EMPTY_APP.moderation, pending: 3, oldest_pending_age_ms: 4 * 60 * 60 * 1000 + 12 * 60 * 1000 },
        },
      }),
    );
    const { toJSON } = await renderObservatory();
    const text = JSON.stringify(toJSON());
    expect(text).toContain("4h 12m");
  });

  // The contract's own point: `null` (nothing pending at all) and `0`
  // (something pending, created this instant) must never collapse into the
  // same rendered string.
  it("renders a null oldest_pending_age_ms as a calm sentence, not a zero", async () => {
    jest.mocked(getObservatory).mockResolvedValue(
      observatory({ app: { ...EMPTY_APP, moderation: { ...EMPTY_APP.moderation, oldest_pending_age_ms: null } } }),
    );
    const { toJSON } = await renderObservatory();
    const text = JSON.stringify(toJSON());
    expect(text).toContain("Nothing pending");
    expect(text).not.toContain("0m");
    expect(text).not.toContain("<1m");
  });

  it("renders an oldest_pending_age_ms of exactly 0 as a duration, distinct from null", async () => {
    jest.mocked(getObservatory).mockResolvedValue(
      observatory({ app: { ...EMPTY_APP, moderation: { ...EMPTY_APP.moderation, pending: 1, oldest_pending_age_ms: 0 } } }),
    );
    const { toJSON } = await renderObservatory();
    const text = JSON.stringify(toJSON());
    expect(text).toContain("<1m");
    expect(text).not.toContain("Nothing pending");
  });
});

describe("Observatory: search index (#208)", () => {
  it("renders the un-indexed count and the age of the oldest", async () => {
    jest.mocked(getObservatory).mockResolvedValue(
      observatory({
        app: {
          ...EMPTY_APP,
          search_index: {
            enabled: true,
            approved: 40,
            unindexed: 3,
            oldest_unindexed_age_ms: 4 * 60 * 60 * 1000 + 12 * 60 * 1000,
          },
        },
      }),
    );
    const { toJSON } = await renderObservatory();
    const text = JSON.stringify(toJSON());
    expect(text).toContain("Search index");
    expect(text).toContain("No vector");
    expect(text).toContain("4h 12m");
  });

  // Same rule the moderation block follows: "nothing is waiting" and "something
  // has been waiting no time at all" must not render as the same string.
  it("renders a fully-indexed catalogue as a sentence, not a zero", async () => {
    jest.mocked(getObservatory).mockResolvedValue(
      observatory({
        app: { ...EMPTY_APP, search_index: { enabled: true, approved: 40, unindexed: 0, oldest_unindexed_age_ms: null } },
      }),
    );
    const { toJSON } = await renderObservatory();
    const text = JSON.stringify(toJSON());
    expect(text).toContain("Every approved listing is indexed");
  });

  // With SEMANTIC_SEARCH off every listing reads as un-indexed, so a number
  // here would be arithmetically true and completely misleading.
  it("renders no numbers at all when semantic search is off", async () => {
    jest.mocked(getObservatory).mockResolvedValue(observatory({ app: { ...EMPTY_APP, search_index: { enabled: false } } }));
    const { toJSON } = await renderObservatory();
    const text = JSON.stringify(toJSON());
    expect(text).toContain("Semantic search is switched off");
    expect(text).not.toContain("No vector");
  });
});

describe("Observatory: funnel", () => {
  it("renders absolute counts and never a computed percentage", async () => {
    jest.mocked(getObservatory).mockResolvedValue(
      observatory({
        app: {
          ...EMPTY_APP,
          funnel: {
            window_days: 7,
            photos_uploaded: 12,
            listings_created: 8,
            listings_approved: 4,
            listings_requested: 3,
            listings_chosen: 2,
          },
        },
      }),
    );
    const { toJSON } = await renderObservatory();
    const text = JSON.stringify(toJSON());
    expect(text).toContain("12");
    expect(text).toContain("Photos uploaded");
    expect(text).toContain("Listings created");
    // 4 approved of 8 created would be "50%" if this ever grew a ratio —
    // the concrete case the contract's own doc comment on
    // `ObservatoryFunnel` warns a small denominator makes misleading.
    expect(text).not.toContain("50%");
  });
});

describe("Observatory: bulk upload (plan Stage 5)", () => {
  it("renders a calm sentence and no numbers when BULK_UPLOAD is off", async () => {
    jest.mocked(getObservatory).mockResolvedValue(observatory({ app: { ...EMPTY_APP, bulk: { enabled: false } } }));
    const { toJSON } = await renderObservatory();
    const text = JSON.stringify(toJSON());
    expect(text).toContain("switched off");
    expect(text).not.toContain("Batches started");
  });

  it("renders batch/draft/operation/usage/funnel numbers when enabled", async () => {
    jest.mocked(getObservatory).mockResolvedValue(
      observatory({
        app: {
          ...EMPTY_APP,
          bulk: {
            enabled: true,
            batches: { by_state: { draft: 2, submitting: 1, closed: 5, cancelled: 1 }, active: 3, abandoned_draft: 1 },
            drafts: {
              items_by_state: { editing: 4, ready: 0, queued: 2, submitted: 10, failed: 1 },
              items_outstanding: 7,
              photos_reserved: 1,
              photos_stored: 20,
            },
            operations: {
              by_status: { queued: 1, running: 0, done: 4, cancelled: 0 },
              active: 1,
              oldest_active_age_ms: 4 * 60 * 60 * 1000 + 12 * 60 * 1000,
              active_stale_lease_recoveries: 2,
            },
            usage: { owners_today: 3, items_used: 40, photos_used: 120, suggestions_used: 10, owners_at_limit: 1 },
            funnel: {
              window_days: 7,
              batches_started: 5,
              items_submitted: 30,
              items_approved: 25,
              orphan_bytes: 1_500_000,
              moderation_latency_ordinary_median_ms: 60_000,
              moderation_latency_bulk_median_ms: 90_000,
            },
          },
        },
      }),
    );
    const { toJSON } = await renderObservatory();
    const text = JSON.stringify(toJSON());

    expect(text).toContain("Bulk upload");
    expect(text).toContain("Batches started");
    // Operation age formatted the same way moderation ages already are.
    expect(text).toContain("4h 12m");
    // The lease-recovery count is genuinely rendered, not silently dropped.
    expect(text).toContain("Lease recoveries");
    // Orphan bytes rendered in a human unit, not a bare byte count.
    expect(text).toContain("1.5 MB");
    expect(text).not.toContain("switched off");
  });

  it("renders a null oldest_active_age_ms as a calm sentence, not a zero — nothing queued or running is not the same as an age of zero", async () => {
    jest.mocked(getObservatory).mockResolvedValue(
      observatory({
        app: {
          ...EMPTY_APP,
          bulk: {
            enabled: true,
            batches: { by_state: { draft: 0, submitting: 0, closed: 0, cancelled: 0 }, active: 0, abandoned_draft: 0 },
            drafts: { items_by_state: { editing: 0, ready: 0, queued: 0, submitted: 0, failed: 0 }, items_outstanding: 0, photos_reserved: 0, photos_stored: 0 },
            operations: {
              by_status: { queued: 0, running: 0, done: 0, cancelled: 0 },
              active: 0,
              oldest_active_age_ms: null,
              active_stale_lease_recoveries: 0,
            },
            usage: { owners_today: 0, items_used: 0, photos_used: 0, suggestions_used: 0, owners_at_limit: 0 },
            funnel: {
              window_days: 7,
              batches_started: 0,
              items_submitted: 0,
              items_approved: 0,
              orphan_bytes: 0,
              moderation_latency_ordinary_median_ms: null,
              moderation_latency_bulk_median_ms: null,
            },
          },
        },
      }),
    );
    const { toJSON } = await renderObservatory();
    const text = JSON.stringify(toJSON());
    expect(text).toContain("Nothing queued or running");
    expect(text).not.toContain("0m");
    expect(text).not.toContain("<1m");
  });
});

describe("Observatory: ObservatorySource three-state rendering", () => {
  it("renders 'unconfigured' as a calm setup hint, not an empty chart", async () => {
    jest.mocked(getObservatory).mockResolvedValue(
      observatory({ edge: { state: "unconfigured", reason: "CF_OBSERVATORY_TOKEN is not set" } }),
    );
    const { toJSON } = await renderObservatory();
    const text = JSON.stringify(toJSON());
    expect(text).toContain("NOT CONFIGURED");
    expect(text).toContain("CF_OBSERVATORY_TOKEN is not set");
    expect(text).not.toContain("ERROR");
  });

  it("renders 'error' as a visible problem, distinct from 'unconfigured'", async () => {
    jest.mocked(getObservatory).mockResolvedValue(
      observatory({
        edge: { state: "error", error: "Cloudflare GraphQL returned 500" },
        // Pinned to "ok" (rather than the fixture default "unconfigured")
        // so the assertions below are unambiguously about `edge`'s own
        // rendering, not a coincidental "NOT CONFIGURED" from `logs`.
        logs: { state: "ok", data: { window_days: 7, counts: { error: 0, warning: 0 }, events: [] } },
      }),
    );
    const { toJSON } = await renderObservatory();
    const text = JSON.stringify(toJSON());
    expect(text).toContain("ERROR");
    expect(text).toContain("Cloudflare GraphQL returned 500");
    expect(text).not.toContain("NOT CONFIGURED");
  });

  it("renders 'ok' data, and neither the unconfigured hint nor the error banner", async () => {
    jest.mocked(getObservatory).mockResolvedValue(
      observatory({
        edge: {
          state: "ok",
          data: {
            script: "keepsake-api",
            window_days: 7,
            totals: { requests: 1234, errors: 5, subrequests: 40 },
            cpu_time_p50_us: 800,
            cpu_time_p99_us: 4200,
            by_day: [{ date: "2026-09-06", requests: 200, errors: 1, subrequests: 6 }],
          },
        },
        logs: { state: "ok", data: { window_days: 7, counts: { error: 0, warning: 0 }, events: [] } },
      }),
    );
    const { toJSON } = await renderObservatory();
    const text = JSON.stringify(toJSON());
    expect(text).toContain("1234");
    expect(text).not.toContain("NOT CONFIGURED");
    expect(text).not.toContain("ERROR");
  });

  it("independently renders logs as 'unconfigured' while edge is 'ok'", async () => {
    jest.mocked(getObservatory).mockResolvedValue(
      observatory({
        edge: {
          state: "ok",
          data: {
            script: "keepsake-api",
            window_days: 7,
            totals: { requests: 10, errors: 0, subrequests: 0 },
            cpu_time_p50_us: null,
            cpu_time_p99_us: null,
            by_day: [],
          },
        },
        logs: { state: "unconfigured", reason: "CF_OBSERVATORY_TOKEN is not set" },
      }),
    );
    const { toJSON } = await renderObservatory();
    const text = JSON.stringify(toJSON());
    // Exactly one NOT CONFIGURED hint (logs), not two — edge is "ok" and
    // must not also render the unconfigured hint just because logs did.
    expect(text.match(/NOT CONFIGURED/g)?.length).toBe(1);
  });
});

describe("Observatory: logs, most recent first", () => {
  it("renders events most-recent-first even when the API returns them out of order", async () => {
    jest.mocked(getObservatory).mockResolvedValue(
      observatory({
        logs: {
          state: "ok",
          data: {
            window_days: 3,
            counts: { error: 2, warning: 0 },
            events: [
              { ts: NOW - 60_000, level: "error", message: "older failure", service: "api", request_id: "r1" },
              { ts: NOW - 5_000, level: "error", message: "newest failure", service: "api", request_id: "r2" },
            ],
          },
        },
      }),
    );
    const { toJSON } = await renderObservatory();
    const text = JSON.stringify(toJSON());
    expect(text.indexOf("newest failure")).toBeLessThan(text.indexOf("older failure"));
  });
});

describe("Observatory: 401 handling", () => {
  it("calls onSessionExpired on a 401 and does not render a fetch-error banner", async () => {
    jest.mocked(getObservatory).mockRejectedValue(new ApiError("unauthorized", "Invalid admin token", 401));
    const onSessionExpired = jest.fn();
    const { toJSON } = await renderObservatory(onSessionExpired);
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(toJSON())).not.toContain("Couldn't load");
  });
});

describe("Observatory: fetch failure", () => {
  it("shows a visible error and does not silently render as an empty panel", async () => {
    jest.mocked(getObservatory).mockRejectedValue(new ApiError("unavailable", "Couldn't reach Keepsake.", 0));
    const { toJSON } = await renderObservatory();
    expect(JSON.stringify(toJSON())).toContain("Couldn't reach Keepsake.");
  });
});

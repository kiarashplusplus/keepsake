/**
 * The daily digest email's bulk-upload line (`src/email/templates/dailyDigest.ts`,
 * plan Stage 5) — "the same numbers in the daily digest, so a quiet day still
 * reports." `observatoryBulk.test.ts` already proves `buildDailyReport`
 * computes `report.bulk` correctly and raises the right alerts; this file is
 * the one layer that isn't covered there — that the template actually
 * *renders* the block, in both the HTML and the plain-text bodies, and
 * omits it cleanly (not as a row of zeros) when `BULK_UPLOAD` is off.
 */
import { describe, expect, it } from "vitest";
import type { DailyReport } from "@keepsake/contracts/observatory";
import { dailyDigest } from "../src/email/templates/dailyDigest.js";

const BASE_REPORT: DailyReport = {
  date: "2026-09-07",
  generated_at: Date.now(),
  environment: "preview",
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

describe("dailyDigest template: bulk upload block", () => {
  it("omits the bulk lines entirely when report.bulk is null, rather than printing zeros", () => {
    const { html, text } = dailyDigest(BASE_REPORT);
    expect(html).not.toContain("Bulk batches active");
    expect(text).not.toContain("Bulk batches active");
  });

  it("renders every bulk number in both the html and text bodies when report.bulk is set", () => {
    const report: DailyReport = {
      ...BASE_REPORT,
      bulk: {
        active_batches: 4,
        items_outstanding: 12,
        oldest_operation_age_ms: 5 * 3_600_000 + 30 * 60_000,
        active_stale_lease_recoveries: 2,
        orphan_bytes: 2_500_000,
      },
    };
    const { html, text } = dailyDigest(report);

    for (const body of [html, text]) {
      expect(body).toContain("Bulk batches active");
      expect(body).toContain("4");
      expect(body).toContain("Bulk items outstanding");
      expect(body).toContain("12");
      expect(body).toContain("Bulk oldest operation");
      // `ageWords` (this template's own helper) rounds to whole hours in
      // this range — same rule `Oldest pending` already renders by, not a
      // second convention invented for this line.
      expect(body).toContain("5h");
      expect(body).toContain("Bulk lease recoveries (active)");
      expect(body).toContain("Bulk orphan bytes");
      expect(body).toContain("2.5 MB");
    }
  });

  it("renders a null oldest_operation_age_ms as an em dash, not a zero", () => {
    const report: DailyReport = {
      ...BASE_REPORT,
      bulk: {
        active_batches: 0,
        items_outstanding: 0,
        oldest_operation_age_ms: null,
        active_stale_lease_recoveries: 0,
        orphan_bytes: 0,
      },
    };
    const { html, text } = dailyDigest(report);
    // `ageWords(null)` renders "—" everywhere else in this template
    // (`Oldest pending`); the bulk line must use the same rule rather than
    // inventing a second convention for "nothing queued or running".
    expect(html).toContain("Bulk oldest operation");
    expect(text).toContain("Bulk oldest operation: —");
  });

  it("renders sub-kilobyte orphan bytes as a bare byte count", () => {
    const report: DailyReport = { ...BASE_REPORT, bulk: { active_batches: 0, items_outstanding: 0, oldest_operation_age_ms: null, active_stale_lease_recoveries: 0, orphan_bytes: 512 } };
    const { text } = dailyDigest(report);
    expect(text).toContain("Bulk orphan bytes: 512 B");
  });
});

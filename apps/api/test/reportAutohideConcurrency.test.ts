/**
 * Issue #184 — the report auto-hide threshold was evaluated against a
 * pre-increment `report_count`.
 *
 * The `UPDATE listings SET report_count = report_count + 1` was always
 * atomic. The decision that read it was not: `row` came from
 * `fetchListingRow` at the top of the handler, before the `reports` insert
 * and before the increment, and the branch compared `row.report_count + 1`
 * against the threshold. Three reports landing in the same second — which is
 * how reports on genuinely bad content actually arrive, since they arrive
 * when the content is being seen — each read 0, each computed 1, and none
 * hid. Auto-hide is the one mechanism that can pull a listing out of public
 * view with no human involved, and it degraded precisely under the load it
 * exists for.
 *
 * This test is deliberately **concurrent**, not sequential. `reports.test.ts`
 * already has the three-sequential-reports case; it passed before the fix and
 * still passes, which is exactly why it was not evidence.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { freshClientIp, insertApprovedListing, insertOwner } from "./helpers.js";

function report(listingId: string, clientIp: string): Promise<Response> {
  return SELF.fetch(`http://x/api/listings/${listingId}/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": clientIp },
    body: JSON.stringify({ reason: "not_a_keepsake" }),
  });
}

describe("report auto-hide under concurrent reports (issue #184)", () => {
  it("hides on three OVERLAPPING reports, not just three sequential ones", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });

    // All three dispatched before any is awaited, so all three handlers are
    // in flight together and each one's opening `fetchListingRow` runs
    // before any of the three increments commits — the exact interleaving
    // the stale read could not survive.
    const responses = await Promise.all([
      report(listingId, freshClientIp()),
      report(listingId, freshClientIp()),
      report(listingId, freshClientIp()),
    ]);
    expect(responses.map((res) => res.status)).toEqual([201, 201, 201]);

    const row = await env.DB.prepare("SELECT status, report_count FROM listings WHERE id = ?")
      .bind(listingId)
      .first<{ status: string; report_count: number }>();
    expect(row?.report_count).toBe(3);
    expect(row?.status).toBe("hidden");

    // The event matters as much as the status: it is what the admin queue's
    // report-pressure view joins against, and the only durable record that
    // the threshold was ever crossed.
    const events = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM moderation_events WHERE listing_id = ? AND kind = 'report_autohide'",
    )
      .bind(listingId)
      .first<{ n: number }>();
    expect(events?.n).toBe(1);
  });

  it("five overlapping reports still hide exactly once", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });

    const responses = await Promise.all(Array.from({ length: 5 }, () => report(listingId, freshClientIp())));
    expect(responses.every((res) => res.status === 201)).toBe(true);

    const row = await env.DB.prepare("SELECT status, report_count FROM listings WHERE id = ?")
      .bind(listingId)
      .first<{ status: string; report_count: number }>();
    expect(row?.report_count).toBe(5);
    expect(row?.status).toBe("hidden");

    // Reading `status` back off the same `RETURNING` row is what keeps the
    // reporters past the threshold from each writing another hide event.
    const events = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM moderation_events WHERE listing_id = ? AND kind = 'report_autohide'",
    )
      .bind(listingId)
      .first<{ n: number }>();
    expect(events?.n).toBe(1);
  });
});

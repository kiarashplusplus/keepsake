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
 * These tests are deliberately **concurrent**, not sequential.
 * `reports.test.ts` already has the three-sequential-reports case; it passed
 * before the fix and still passes, which is exactly why it was not evidence.
 *
 * Every request carries its own `CF-Connecting-IP`, because five people
 * reporting one listing are five people. That also keeps every limiter on
 * this route fully armed rather than dodged: `burst("RL_REPORT")` (5/60s),
 * the router-level `burst("RL_WRITE")` (60/60s, issue #168) and the per-IP
 * `report` daily budget (10) are all keyed by the caller's address, so
 * distinct addresses exercise them exactly as production would.
 */
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { freshClientIp, insertApprovedListing, insertOwner, setTestEnvVar } from "./helpers.js";

function report(listingId: string, clientIp: string): Promise<Response> {
  return SELF.fetch(`http://x/api/listings/${listingId}/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": clientIp },
    body: JSON.stringify({ reason: "not_a_keepsake" }),
  });
}

async function listingRow(listingId: string): Promise<{ status: string; report_count: number }> {
  const row = await env.DB.prepare("SELECT status, report_count FROM listings WHERE id = ?")
    .bind(listingId)
    .first<{ status: string; report_count: number }>();
  if (!row) throw new Error(`listing ${listingId} vanished`);
  return row;
}

async function autohideEventCount(listingId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM moderation_events WHERE listing_id = ? AND kind = 'report_autohide'")
    .bind(listingId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("report auto-hide under concurrent reports (issue #184)", () => {
  afterEach(() => setTestEnvVar("REPORT_AUTOHIDE_THRESHOLD", "3"));

  it("hides on three OVERLAPPING reports, not just three sequential ones", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });

    // All three dispatched before any is awaited, so all three handlers are
    // in flight together and each one's opening `fetchListingRow` runs
    // before any of the three increments commits — the exact interleaving
    // the stale read could not survive.
    //
    // No request here can be refused by the route's own "is this listing
    // still public" gate, whatever the scheduling: the hide requires a third
    // increment, so it cannot possibly have happened before the third (and
    // last) request reads the row. That makes all-201 an invariant rather
    // than a scheduling outcome.
    const responses = await Promise.all([
      report(listingId, freshClientIp()),
      report(listingId, freshClientIp()),
      report(listingId, freshClientIp()),
    ]);
    expect(responses.map((res) => res.status)).toEqual([201, 201, 201]);

    const row = await listingRow(listingId);
    expect(row.report_count).toBe(3);
    expect(row.status).toBe("hidden");

    // The event matters as much as the status: it is what the admin queue's
    // report-pressure view joins against, and the only durable record that
    // the threshold was ever crossed.
    expect(await autohideEventCount(listingId)).toBe(1);
  });

  it("five overlapping reports at a threshold of five: every one accepted, hidden exactly once", async () => {
    // `REPORT_AUTOHIDE_THRESHOLD = 5` with exactly five reporters, for the
    // same reason the three-report case above is stable at three: the hide
    // cannot happen until the *last* increment, so no request can meet the
    // route's `status !== 'approved'` gate and be told 404. All five are
    // accepted under every possible interleaving.
    //
    // This replaces an earlier version of this case that ran five reporters
    // against the default threshold of 3 and asserted all five were 201.
    // That was asserting a scheduling outcome, not an invariant, and it went
    // red on a loaded CI runner with `[201, 201, 201, 404, 404]` — the first
    // three had already hidden the listing, so the last two correctly hit
    // the route's "a hidden listing is not publicly reportable" 404. The
    // guard was working; the assertion was wrong. (Reproduced locally under
    // CPU load before changing anything: it is a 404 from that gate, not a
    // 429 from any limiter and not a 409 from the duplicate-`ip_digest`
    // check — both of those would be real regressions and both are still
    // failures here, because this asserts the exact status of every
    // response.)
    setTestEnvVar("REPORT_AUTOHIDE_THRESHOLD", "5");

    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });

    const responses = await Promise.all(Array.from({ length: 5 }, () => report(listingId, freshClientIp())));
    expect(responses.map((res) => res.status)).toEqual([201, 201, 201, 201, 201]);

    const row = await listingRow(listingId);
    expect(row.report_count).toBe(5);
    expect(row.status).toBe("hidden");
    expect(await autohideEventCount(listingId)).toBe(1);
  });

  it("five overlapping reports past a threshold of three still hide exactly once", async () => {
    // The case that found the second race, kept. With the threshold at 3 and
    // five reporters, the callers who increment to 3, 4 and 5 all satisfy
    // `count >= threshold`, and more than one of them can read `approved`
    // off its own `RETURNING` row because the winner's hide has not
    // committed yet — measured at two `report_autohide` events for one hide
    // before the hide UPDATE gained `RETURNING id` as a compare-and-set.
    //
    // Said plainly, because it is the kind of thing this repo has been
    // burned by: *how much* of that overlap happens on any given run is not
    // guaranteed, so this case does not always exercise the second race. The
    // case above is the deterministic half. What is asserted here holds
    // under every interleaving — nothing but 201 and 404 (a 429 or a 409
    // fails), a 404 only ever from the post-hide gate, `report_count`
    // matching the number of accepted reports exactly, and one event.
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });

    const responses = await Promise.all(Array.from({ length: 5 }, () => report(listingId, freshClientIp())));
    const statuses = responses.map((res) => res.status);

    expect(statuses.filter((status) => status !== 201 && status !== 404)).toEqual([]);
    const accepted = statuses.filter((status) => status === 201).length;
    // The first three cannot be refused — the hide needs a third increment —
    // so at least three are always accepted, and each 404 is a report that
    // arrived after the listing had already left public view.
    expect(accepted).toBeGreaterThanOrEqual(3);

    const row = await listingRow(listingId);
    expect(row.report_count).toBe(accepted);
    expect(row.status).toBe("hidden");

    // Reading `status` back off the same `RETURNING` row, plus the
    // compare-and-set on the hide, is what keeps the reporters past the
    // threshold from each writing another hide event.
    expect(await autohideEventCount(listingId)).toBe(1);
  });
});

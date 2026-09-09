/**
 * Issue #89: a listing auto-hidden by three reports paged nobody. `/health`
 * is a Worker liveness check and stayed `ok: true` throughout; the
 * `captureMessage` the auto-hide fires goes to Workers Logs, which nothing
 * reads on a schedule.
 *
 * These tests drive the **real** report route three times from three
 * distinct addresses, so the real auto-hide branch in
 * `src/routes/listings.ts` is what flips the status — no hand-written
 * `UPDATE listings SET status = 'hidden'`, which would prove nothing about
 * whether the alert is wired to the thing that actually happens in
 * production. The schema is the real one too: `test/setup.ts` applies
 * `migrations/*.sql` into the vitest-pool-workers D1.
 *
 * Kept in its own file rather than added to `admin.test.ts` because D1 is
 * shared across every `it` in a file and this one needs a *clean* baseline —
 * `report_pressure` empty and `ok: true` — before it can prove the auto-hide
 * is what changed the verdict.
 */
import { env, SELF } from "cloudflare:test";
import { CRON_JOB_NAMES, cronHeartbeatKey } from "../src/cron/registry.js";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminHealth } from "@keepsake/contracts/admin";
import { freshClientIp, insertApprovedListing, insertOwner, readOk, seedStandardPostalCodes, setTestEnvVar } from "./helpers.js";

const ADMIN_TOKEN = "test-admin-token-report-pressure-89";

function adminHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" };
}

async function report(listingId: string): Promise<Response> {
  return SELF.fetch(`http://x/api/listings/${listingId}/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": freshClientIp() },
    body: JSON.stringify({ reason: "not_a_keepsake" }),
  });
}

async function getHealth(): Promise<AdminHealth> {
  const res = await SELF.fetch("http://x/api/admin/health", { headers: adminHeaders() });
  const health = await readOk<AdminHealth>(res);
  // This file drives the verdict both ways, so it cannot assert one fixed
  // status: `/api/admin/health` answers a red verdict with 503, matching
  // public `/health`. Tying the two together here means the status code is
  // checked on every call in the file rather than trusted once.
  expect(res.status).toBe(health.ok ? 200 : 503);
  return health;
}

async function listingStatus(id: string): Promise<string | undefined> {
  const row = await env.DB.prepare("SELECT status FROM listings WHERE id = ?").bind(id).first<{ status: string }>();
  return row?.status;
}

/** Everything `AdminHealth.ok` depends on *besides* report pressure, so a
 * false verdict below can only have come from the auto-hide. */
async function makeOtherwiseHealthy(): Promise<void> {
  setTestEnvVar("ADMIN_TOKEN", ADMIN_TOKEN);
  await seedStandardPostalCodes();
  // Seeded from the registry rather than from a hand-written list.
  // `/health` derives `ok` from *every* job in `CRON_JOBS`, so each new cron
  // used to turn this file red until someone added a fourth, then a fifth
  // line — a chore AGENTS.md warns about and #208 collected. A loop over the
  // registry cannot fall behind it.
  for (const name of CRON_JOB_NAMES) {
    await env.KV.put(cronHeartbeatKey(name), String(Date.now()));
  }
}

describe("GET /api/admin/health — report pressure (#89)", () => {
  afterEach(() => setTestEnvVar("ADMIN_TOKEN", ""));

  // D1 is shared across every `it` in this file, so order is load-bearing:
  // the auto-hide left behind by the last test never gets an admin action,
  // which is exactly what keeps `ok` false — every test that asserts
  // `ok: true` therefore has to run before it.
  it("is green, with nothing under report pressure, before anyone reports anything", async () => {
    await makeOtherwiseHealthy();

    const health = await getHealth();
    expect(health.ok).toBe(true);
    expect(health.report_pressure.threshold).toBe(3);
    expect(health.report_pressure.autohidden_awaiting_review).toEqual([]);
    expect(health.report_pressure.near_threshold).toEqual([]);
  });

  it("names a listing one report short of the threshold without turning the verdict red", async () => {
    await makeOtherwiseHealthy();
    const listingId = await insertApprovedListing({ ownerId: await insertOwner() });

    expect((await report(listingId)).status).toBe(201);
    expect((await report(listingId)).status).toBe(201);
    expect(await listingStatus(listingId)).toBe("approved");

    const health = await getHealth();
    expect(health.report_pressure.near_threshold).toContainEqual({ listing_id: listingId, report_count: 2 });
    expect(health.report_pressure.autohidden_awaiting_review).toEqual([]);
    // Two reports is a heads-up, not a fault: nothing has been taken down
    // yet and there is nothing for an admin to undo.
    expect(health.ok).toBe(true);
  });

  it("does not list a listing an admin hid by hand — only ones the report threshold took down", async () => {
    await makeOtherwiseHealthy();
    const listingId = await insertApprovedListing({ ownerId: await insertOwner() });

    const hide = await SELF.fetch(`http://x/api/admin/listings/${listingId}/hide`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ reason: "hand-hidden for this test" }),
    });
    expect(hide.status).toBe(200);
    expect(await listingStatus(listingId)).toBe("hidden");

    const health = await getHealth();
    expect(health.report_pressure.autohidden_awaiting_review.some((row) => row.listing_id === listingId)).toBe(false);
    expect(health.ok).toBe(true);
  });

  it("clears the listing off the list — and the verdict back to green — once an admin acts on it", async () => {
    await makeOtherwiseHealthy();
    const listingId = await insertApprovedListing({ ownerId: await insertOwner() });
    await report(listingId);
    await report(listingId);
    await report(listingId);
    expect(await listingStatus(listingId)).toBe("hidden");
    expect((await getHealth()).ok).toBe(false);

    const restore = await SELF.fetch(`http://x/api/admin/listings/${listingId}/restore`, {
      method: "POST",
      headers: adminHeaders(),
    });
    expect(restore.status).toBe(200);

    const health = await getHealth();
    expect(health.report_pressure.autohidden_awaiting_review).toEqual([]);
    expect(health.ok).toBe(true);
    // `restore` also zeroes `report_count`, so it does not reappear as
    // "near threshold" the instant it is vouched for.
    expect(health.report_pressure.near_threshold.some((row) => row.listing_id === listingId)).toBe(false);
  });

  it("turns red and names the listing the moment a third report auto-hides it", async () => {
    await makeOtherwiseHealthy();
    const listingId = await insertApprovedListing({ ownerId: await insertOwner() });

    const before = await getHealth();
    expect(before.ok).toBe(true);

    expect((await report(listingId)).status).toBe(201);
    expect((await report(listingId)).status).toBe(201);
    expect((await report(listingId)).status).toBe(201);

    // The real route did the hiding, not this test.
    expect(await listingStatus(listingId)).toBe("hidden");

    const after = await getHealth();
    expect(after.ok).toBe(false);
    const entry = after.report_pressure.autohidden_awaiting_review.find((row) => row.listing_id === listingId);
    expect(entry).toBeDefined();
    expect(entry?.report_count).toBe(3);
    expect(entry?.autohidden_at).toBeGreaterThan(0);
    // A listing that is already down is no longer "one report away".
    expect(after.report_pressure.near_threshold.some((row) => row.listing_id === listingId)).toBe(false);
  });
});

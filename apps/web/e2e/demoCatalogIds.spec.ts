/**
 * Issue #225 regression guard.
 *
 * `packages/tokens/src/tilt.ts` hashes a listing's *id* into the resting
 * angle and vertical offset `Print.tsx` renders its card at. The UX
 * baseline's fixed catalogue (`e2e/support/demoCatalog.ts`) is created
 * through the real API on every capture, which used to mean a fresh ULID
 * per listing per run — and a fresh id is a fresh angle, which is what
 * rewrote 16 of the baseline's 76 committed frames on every capture with no
 * code change behind it. `ensureDemoCatalog()` now renames every listing to
 * a fixed id (`DEMO_LISTING_IDS`) after creating it, and this is the check
 * that the rename actually sticks: it hits the real API against a real,
 * freshly-migrated local D1 (same `wrangler dev` every functional spec
 * runs against) and asserts every id `ensureDemoCatalog()` hands back is
 * the fixed constant, not whatever the server just minted.
 *
 * This is not the baseline capture. No screenshot is taken here, nothing
 * under `docs/qa/baseline/` is touched, and this file runs under the
 * ordinary `mobile`/`desktop` projects (`pnpm --filter @keepsake/web e2e`),
 * never under `UX_SHOTS`. It exists because the 76-frame image diff was, up
 * to #225, the *only* thing that would ever have caught a regression here —
 * and an image diff nobody is looking at during an unrelated PR is not a
 * check that can fail loudly.
 *
 * Single-project by design. `ensureDemoCatalog()`'s own header already
 * warns it "is not race-free — two workers entering it at once would both
 * seed", which is exactly what would happen against a freshly wiped
 * database if both `mobile` and `desktop` called it here the way most specs
 * run under both. One call against the real API is enough to prove ids are
 * stable; a second concurrent one would only manufacture the race the
 * fixture's own comment already names, not add coverage.
 */
import { test, expect } from "./support/fixtures";
import { DEMO_HIDDEN_LISTING, DEMO_LISTINGS, DEMO_LISTING_IDS, ensureDemoCatalog } from "./support/demoCatalog";

test("ensureDemoCatalog hands back the fixed ids, not a fresh ULID per run", async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "single-project guard — see file header");

  const catalog = await ensureDemoCatalog(request);

  for (const listing of [...DEMO_LISTINGS, DEMO_HIDDEN_LISTING]) {
    const id = catalog.ids[listing.key];
    // Logged, not just asserted: this is the artifact a second manual run of
    // the suite is compared against to show the ids are stable across a full
    // wipe-and-reseed, not merely internally self-consistent within one run.
    console.log(`[demoCatalog ids] ${listing.key} -> ${id}`);
    expect(id, `listing "${listing.key}" should hold its fixed id`).toBe(DEMO_LISTING_IDS[listing.key]);
  }
});

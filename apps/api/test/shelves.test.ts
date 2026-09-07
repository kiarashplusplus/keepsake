/**
 * Issue #39: `GET /api/feed/shelves` groups approved listings by common
 * aspect name/value pairs, floored at `SHELF_MIN_ITEMS` (pinned to `3` in
 * `vitest.config.ts`, matching `wrangler.toml`'s real default —
 * `shelfMinItems()` in `src/env.ts`).
 *
 * Issue #40's guarantee is exercised here too, from the shelves side rather
 * than the default-feed side already covered by `test/aspects.test.ts`:
 * this file never asserts that a zero-aspect listing appears in a shelf
 * (it structurally can't — it has no aspect rows to group by) and instead
 * asserts the positive shape of what a shelf actually is, so a future
 * change can't accidentally make `/api/feed/shelves` a second, competing
 * "default" listing source.
 *
 * Two things this file learned the hard way and works around rather than
 * assuming away: (1) unlike the per-test D1 isolation `test/aspects.test.ts`
 * benefits from implicitly (every row it writes is scoped to a fresh owner
 * it queries back by exact id), this suite's assertions are about a *global*
 * aggregate across every approved listing, so distinct tests inserting the
 * same aspect value (e.g. "copper") would accumulate across tests in this
 * file and silently corrupt each other's counts — worked around by giving
 * every test its own ulid-suffixed aspect value. (2) the KV cache the route
 * writes to is not reset between tests the way D1 effectively is per-value
 * here — confirmed by running this suite before adding the `beforeEach`
 * below: the first test's cached empty result leaked into the second test's
 * assertions as a stale response. That's the route's real, intended
 * behavior (a change within `SHELF_CACHE_TTL_SECONDS` doesn't appear
 * immediately) — correct in production, but each test here needs its own
 * clean cache slot rather than inheriting whatever an earlier test computed.
 */
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ShelvesResponse } from "@keepsake/contracts/shelves";
import { insertApprovedListing, insertOwner, readOk } from "./helpers.js";
import { ulid } from "../src/lib/ids.js";

/** A per-test-unique aspect value, so this file's tests (which all assert
 * on a global aggregate) never see each other's rows. */
function uniqueValue(label: string): string {
  return `${label}-${ulid()}`;
}

async function addAspect(listingId: string, name: string, value: string, position = 0): Promise<void> {
  await env.DB.prepare("INSERT INTO listing_aspects (id, listing_id, name, value, position, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(ulid(), listingId, name, value, position, Date.now())
    .run();
}

async function fetchShelves(): Promise<ShelvesResponse> {
  return readOk<ShelvesResponse>(await SELF.fetch("http://x/api/feed/shelves"));
}

describe("GET /api/feed/shelves (issue #39)", () => {
  beforeEach(async () => {
    await env.KV.delete("feed:shelves:v1:3");
  });

  it("a value with fewer than SHELF_MIN_ITEMS listings does not become a shelf", async () => {
    const value = uniqueValue("copper");
    const ownerId = await insertOwner();
    const a = await insertApprovedListing({ ownerId, title: "A copper kettle" });
    const b = await insertApprovedListing({ ownerId, title: "A copper bowl" });
    await addAspect(a, "material", value);
    await addAspect(b, "material", value);
    // Only 2 — SHELF_MIN_ITEMS is pinned to 3 in vitest.config.ts.

    const { shelves } = await fetchShelves();
    expect(shelves.find((shelf) => shelf.name === "material" && shelf.value === value)).toBeUndefined();
  });

  it("a value that clears the floor becomes a shelf carrying its matching listings, newest first", async () => {
    const value = uniqueValue("copper");
    const otherValue = uniqueValue("ceramic");
    const ownerId = await insertOwner();
    const older = await insertApprovedListing({ ownerId, title: "An old copper kettle", publishedAt: 1000 });
    const middle = await insertApprovedListing({ ownerId, title: "A copper bowl", publishedAt: 2000 });
    const newest = await insertApprovedListing({ ownerId, title: "A new copper pan", publishedAt: 3000 });
    for (const id of [older, middle, newest]) {
      await addAspect(id, "material", value);
    }
    // A different value must not be swept into the same shelf.
    const other = await insertApprovedListing({ ownerId, title: "A ceramic mug" });
    await addAspect(other, "material", otherValue);

    const { shelves, min_items } = await fetchShelves();
    expect(min_items).toBe(3);

    const shelf = shelves.find((s) => s.name === "material" && s.value === value);
    expect(shelf).toBeDefined();
    expect(shelf?.count).toBe(3);
    expect(shelf?.items.map((item) => item.id)).toEqual([newest, middle, older]);
    expect(shelf?.items.every((item) => item.aspects.some((a) => a.name === "material" && a.value === value))).toBe(true);

    expect(shelves.find((s) => s.name === "material" && s.value === otherValue)).toBeUndefined();
  });

  it("a listing with zero aspects never appears inside any shelf's items", async () => {
    const value = uniqueValue("copper");
    const ownerId = await insertOwner();
    for (let i = 0; i < 3; i += 1) {
      const id = await insertApprovedListing({ ownerId, title: `Copper item ${i}` });
      await addAspect(id, "material", value);
    }
    const zeroAspectId = await insertApprovedListing({ ownerId, title: "A plain wooden spoon" });

    const { shelves } = await fetchShelves();
    for (const shelf of shelves) {
      expect(shelf.items.map((item) => item.id)).not.toContain(zeroAspectId);
    }
  });

  it("caches the aggregate: a listing approved after the first call does not appear in the second call's count within the TTL", async () => {
    const value = uniqueValue("brass");
    const ownerId = await insertOwner();
    for (let i = 0; i < 3; i += 1) {
      const id = await insertApprovedListing({ ownerId, title: `Brass item ${i}` });
      await addAspect(id, "material", value);
    }

    const first = await fetchShelves();
    const firstShelf = first.shelves.find((shelf) => shelf.name === "material" && shelf.value === value);
    expect(firstShelf?.count).toBe(3);

    // A fourth listing with the same aspect value lands after the cache was primed.
    const fourth = await insertApprovedListing({ ownerId, title: "Brass item 4" });
    await addAspect(fourth, "material", value);

    const second = await fetchShelves();
    const secondShelf = second.shelves.find((shelf) => shelf.name === "material" && shelf.value === value);
    // Still 3, not 4 — proves the second request was served from KV rather
    // than re-running the D1 aggregate.
    expect(secondShelf?.count).toBe(3);
  });
});

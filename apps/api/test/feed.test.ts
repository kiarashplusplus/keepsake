import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PublicListing } from "@keepsake/contracts/listing";
import type { FeedPage } from "@keepsake/contracts/feed";
import { insertApprovedListing, insertOwner, readOk, seedStandardPostalCodes } from "./helpers.js";

async function fetchFeed(query: string): Promise<Response> {
  return SELF.fetch(`http://x/api/feed${query}`);
}

describe("GET /api/feed — default keyset mode", () => {
  it("paginates 30 approved listings to the end with no duplicates or gaps", async () => {
    const ownerId = await insertOwner();
    const ids: string[] = [];
    for (let i = 0; i < 30; i++) {
      // Distinct published_at so keyset ordering is unambiguous even though
      // these all land in the same millisecond in a tight loop otherwise.
      ids.push(await insertApprovedListing({ ownerId, title: `Keepsake number ${i}`, publishedAt: Date.now() + i }));
    }

    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor ? `?limit=12&cursor=${encodeURIComponent(cursor)}` : "?limit=12";
      const page: FeedPage<PublicListing> = await readOk<FeedPage<PublicListing>>(await fetchFeed(query));
      for (const item of page.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      cursor = page.next_cursor;
      pages += 1;
      expect(pages).toBeLessThan(20); // guard against an infinite loop on a bug
    } while (cursor);

    expect(seen.size).toBe(30);
    for (const id of ids) {
      expect(seen.has(id)).toBe(true);
    }
  });

  it("filters by category", async () => {
    const ownerId = await insertOwner();
    await insertApprovedListing({ ownerId, category: "books_letters", title: "A letter" });
    await insertApprovedListing({ ownerId, category: "home_kitchen", title: "A teacup" });

    const page = await readOk<FeedPage<PublicListing>>(await fetchFeed("?category=books_letters"));
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.title).toBe("A letter");
  });

  it("excludes given, hidden, and pending listings", async () => {
    const ownerId = await insertOwner();
    const approvedId = await insertApprovedListing({ ownerId, title: "Still available" });
    const givenId = await insertApprovedListing({ ownerId, title: "Already given" });
    await env.DB.prepare("UPDATE listings SET status = 'given', given_at = ? WHERE id = ?").bind(Date.now(), givenId).run();

    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO listings (id, owner_id, title, story, category, country, postal_code, place_name, admin1, lat, lng, status, version, created_at, updated_at)
       VALUES (?, ?, 'A pending one', 'This story is long enough to pass validation, at least twenty characters.', 'other', 'US', '02144', 'Somerville', 'MA', 42.3958, -71.0967, 'pending', 1, ?, ?)`,
    )
      .bind("01ATESTPENDINGXXXXXXXXXXXX", ownerId, now, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO listings (id, owner_id, title, story, category, country, postal_code, place_name, admin1, lat, lng, status, version, created_at, updated_at)
       VALUES (?, ?, 'A hidden one', 'This story is long enough to pass validation, at least twenty characters.', 'other', 'US', '02144', 'Somerville', 'MA', 42.3958, -71.0967, 'hidden', 1, ?, ?)`,
    )
      .bind("01ATESTHIDDENXXXXXXXXXXXXX", ownerId, now, now)
      .run();

    const page = await readOk<FeedPage<PublicListing>>(await fetchFeed("?limit=48"));
    const ids = page.items.map((item) => item.id);
    expect(ids).toContain(approvedId);
    expect(ids).not.toContain(givenId);
    expect(ids).not.toContain("01ATESTPENDINGXXXXXXXXXXXX");
    expect(ids).not.toContain("01ATESTHIDDENXXXXXXXXXXXXX");
  });
});

describe("GET /api/feed?q= — FTS5 search mode", () => {
  it("finds \"grandmother's\" when searching for \"grandmother\" (trailing prefix wildcard)", async () => {
    const ownerId = await insertOwner();
    await insertApprovedListing({
      ownerId,
      title: "A quiet teacup",
      story: "This was my grandmother's favorite teacup, and I'd love for it to find a new home.",
    });
    await insertApprovedListing({ ownerId, title: "An old lamp", story: "This lamp belonged to a dear friend of the family." });

    const page = await readOk<FeedPage<PublicListing>>(await fetchFeed("?q=grandmother"));
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.title).toBe("A quiet teacup");
  });
});

describe("GET /api/feed — geo radius mode", () => {
  it("25 mi from 02144 includes a Cambridge (02139) listing and excludes a Worcester (01608) one", async () => {
    await seedStandardPostalCodes();
    const ownerId = await insertOwner();
    const cambridgeId = await insertApprovedListing({
      ownerId,
      title: "Cambridge keepsake",
      postalCode: "02139",
      placeName: "Cambridge",
      admin1: "MA",
      lat: 42.3736,
      lng: -71.1097,
    });
    const worcesterId = await insertApprovedListing({
      ownerId,
      title: "Worcester keepsake",
      postalCode: "01608",
      placeName: "Worcester",
      admin1: "MA",
      lat: 42.2626,
      lng: -71.8023,
    });

    // limit=48 (the max page size): this describe block's earlier tests
    // share this file's D1 state and default to the same Somerville
    // coordinates (distance 0, so they always sort ahead of Cambridge's
    // ~1.7 mi) — a small limit would page Cambridge out before this
    // assertion ever sees it, which is a test-isolation artifact, not
    // something the geo mode itself needs to guarantee.
    const page = await readOk<FeedPage<PublicListing>>(await fetchFeed("?country=US&postal=02144&radius_mi=25&limit=48"));
    const ids = page.items.map((item) => item.id);
    expect(ids).toContain(cambridgeId);
    expect(ids).not.toContain(worcesterId);

    const cambridgeItem = page.items.find((item) => item.id === cambridgeId);
    expect(cambridgeItem?.distance_mi).toBeDefined();
    expect(cambridgeItem?.distance_mi ?? 100).toBeLessThan(25);
  });

  it("400s bad_request for a postcode the geo seed doesn't cover", async () => {
    const res = await fetchFeed("?country=US&postal=99999");
    expect(res.status).toBe(400);
  });

  it("accepts lat/lng directly without a postcode lookup", async () => {
    const ownerId = await insertOwner();
    const nearbyId = await insertApprovedListing({
      ownerId,
      title: "Right here",
      lat: 42.3958,
      lng: -71.0967,
    });

    const page = await readOk<FeedPage<PublicListing>>(await fetchFeed("?lat=42.3958&lng=-71.0967&radius_mi=10"));
    expect(page.items.map((item) => item.id)).toContain(nearbyId);
  });
});

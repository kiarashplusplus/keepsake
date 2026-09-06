import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("migrations", () => {
  it("creates every table from 0001-0003", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')",
    ).all<{ name: string }>();
    const names = results.map((row) => row.name);

    for (const table of [
      "owners",
      "listings",
      "photos",
      "requests",
      "reports",
      "moderation_events",
      "recovery_tokens",
      "postal_codes",
      "listings_fts",
    ]) {
      expect(names).toContain(table);
    }
  });

  it("keeps listings_fts in sync via triggers and finds a prefix match", async () => {
    const now = Date.now();

    await env.DB.prepare(
      "INSERT INTO owners (id, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)",
    )
      .bind("owner_1", "hash_1", now, now)
      .run();

    await env.DB.prepare(
      `INSERT INTO listings
        (id, owner_id, title, story, category, country, postal_code, place_name, admin1, lat, lng, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "listing_1",
        "owner_1",
        "A quiet teacup",
        "This was my grandmother's favorite teacup, and I'd love for it to find a new home.",
        "home_kitchen",
        "US",
        "02144",
        "Somerville",
        "MA",
        42.3958,
        -71.0967,
        "approved",
        now,
        now,
      )
      .run();

    const { results } = await env.DB.prepare(
      "SELECT rowid FROM listings_fts WHERE listings_fts MATCH ?",
    )
      .bind("grandmother*")
      .all<{ rowid: number }>();

    expect(results.length).toBe(1);

    const { results: listingRows } = await env.DB.prepare(
      "SELECT id FROM listings WHERE rowid = ?",
    )
      .bind(results[0]?.rowid)
      .all<{ id: string }>();
    expect(listingRows[0]?.id).toBe("listing_1");
  });
});

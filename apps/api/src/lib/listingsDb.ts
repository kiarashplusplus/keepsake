/** Shared row-fetch helpers used by both `src/routes/listings.ts` and
 * `src/routes/me.ts`, so the two route modules never drift on column lists. */
import type { Env } from "../env.js";
import type { ListingRow, PhotoRow } from "./serialize.js";

export async function fetchListingRow(env: Env, id: string): Promise<ListingRow | null> {
  return env.DB.prepare(
    `SELECT id, owner_id, title, story, category, country, postal_code, place_name, admin1, lat, lng,
            status, moderation_reason, version, report_count, request_count, chosen_request_id,
            created_at, updated_at, published_at, given_at
     FROM listings WHERE id = ?`,
  )
    .bind(id)
    .first<ListingRow>();
}

export async function fetchPhotoRows(env: Env, listingId: string): Promise<PhotoRow[]> {
  const { results } = await env.DB.prepare("SELECT id, width, height, blurhash FROM photos WHERE listing_id = ? ORDER BY position")
    .bind(listingId)
    .all<PhotoRow>();
  return results;
}

/** Batches the same lookup `fetchPhotoRows` does across a whole feed page,
 * so `src/routes/feed.ts` issues one query for up to `limit` listings
 * instead of N+1. Returns a map so callers can look photos up per listing in
 * whatever order the page itself is in. */
export async function fetchPhotoRowsForListings(env: Env, listingIds: string[]): Promise<Map<string, PhotoRow[]>> {
  const byListing = new Map<string, PhotoRow[]>();
  if (listingIds.length === 0) return byListing;

  const placeholders = listingIds.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT id, listing_id, width, height, blurhash FROM photos WHERE listing_id IN (${placeholders}) ORDER BY listing_id, position`,
  )
    .bind(...listingIds)
    .all<PhotoRow & { listing_id: string }>();

  for (const row of results) {
    const existing = byListing.get(row.listing_id);
    if (existing) {
      existing.push(row);
    } else {
      byListing.set(row.listing_id, [row]);
    }
  }
  return byListing;
}

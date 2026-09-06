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

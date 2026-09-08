/** Shared row-fetch helpers used by both `src/routes/listings.ts` and
 * `src/routes/me.ts`, so the two route modules never drift on column lists. */
import type { Aspect } from "@keepsake/contracts/listing";
import { ulid } from "./ids.js";
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
  const { results } = await env.DB.prepare(
    "SELECT id, width, height, blurhash, content_type FROM photos WHERE listing_id = ? ORDER BY position",
  )
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

/** Mirrors `fetchPhotoRows` for `listing_aspects` (migration 0006) — one
 * listing's aspects, in the model's own emitted order (`position`). */
export async function fetchAspectRows(env: Env, listingId: string): Promise<Aspect[]> {
  const { results } = await env.DB.prepare("SELECT name, value FROM listing_aspects WHERE listing_id = ? ORDER BY position")
    .bind(listingId)
    .all<Aspect>();
  return results;
}

/** Batches `fetchAspectRows` across a feed page — same shape as
 * `fetchPhotoRowsForListings`, for the same N+1 reason. */
export async function fetchAspectRowsForListings(env: Env, listingIds: string[]): Promise<Map<string, Aspect[]>> {
  const byListing = new Map<string, Aspect[]>();
  if (listingIds.length === 0) return byListing;

  const placeholders = listingIds.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT listing_id, name, value FROM listing_aspects WHERE listing_id IN (${placeholders}) ORDER BY listing_id, position`,
  )
    .bind(...listingIds)
    .all<Aspect & { listing_id: string }>();

  for (const row of results) {
    const existing = byListing.get(row.listing_id);
    const aspect = { name: row.name, value: row.value };
    if (existing) {
      existing.push(aspect);
    } else {
      byListing.set(row.listing_id, [aspect]);
    }
  }
  return byListing;
}

/**
 * Replaces every aspect row for `listingId` with `aspects`, in order —
 * delete-then-reinsert rather than a diff, matching how `PATCH
 * /api/listings/:id` already re-attaches `photo_ids` wholesale. Called from
 * both `POST /api/listings` (fresh insert, nothing to delete) and `PATCH`
 * (only when the request body actually included an `aspects` key — see
 * `routes/listings.ts`, which must not call this on every edit or a client
 * that never sends `aspects` would silently wipe a listing's existing ones).
 */
export async function replaceListingAspects(env: Env, listingId: string, aspects: Aspect[]): Promise<void> {
  await env.DB.prepare("DELETE FROM listing_aspects WHERE listing_id = ?").bind(listingId).run();
  const now = Date.now();
  for (let position = 0; position < aspects.length; position++) {
    const aspect = aspects[position];
    if (!aspect) continue;
    await env.DB.prepare(
      "INSERT INTO listing_aspects (id, listing_id, name, value, position, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(ulid(), listingId, aspect.name, aspect.value, position, now)
      .run();
  }
}

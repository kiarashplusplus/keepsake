/**
 * Row → API-shape mapping, kept in one place so `PublicListing`/`OwnerListing`
 * (both from `@keepsake/contracts/listing`) are always built the same way
 * regardless of which route is assembling them.
 */
import type { PublicPhoto } from "@keepsake/contracts/photo";
import type { Aspect, Category, ListingStatus, ModerationReasonCode, OwnerListing, PublicListing } from "@keepsake/contracts/listing";
import type { Country } from "@keepsake/contracts/geo";

export interface ListingRow {
  id: string;
  owner_id: string;
  title: string;
  story: string;
  category: string;
  country: string;
  postal_code: string;
  place_name: string;
  admin1: string | null;
  lat: number;
  lng: number;
  status: string;
  moderation_reason: string | null;
  version: number;
  report_count: number;
  request_count: number;
  chosen_request_id: string | null;
  created_at: number;
  updated_at: number;
  published_at: number | null;
  given_at: number | null;
}

export interface PhotoRow {
  id: string;
  width: number;
  height: number;
  blurhash: string;
  /** Present only where the query selects it — `fetchPhotoRows` does, because
   * `routes/item.ts` has to know whether the share card can be drawn from
   * this photo before it declares the `og:image` dimensions. */
  content_type?: string;
}

export function serializePhoto(row: PhotoRow): PublicPhoto {
  return {
    id: row.id,
    width: row.width,
    height: row.height,
    blurhash: row.blurhash,
    url_full: `/i/${row.id}/full`,
    url_thumb: `/i/${row.id}/thumb`,
  };
}

/**
 * The exact fields `serializePublicListing` reads, as a structural type
 * rather than the full `ListingRow` — so `src/routes/feed.ts`'s leaner
 * `FeedListingRow` (which never selects `owner_id`, `moderation_reason`, and
 * the other owner-only columns) satisfies this by having the same field
 * names/types, with no cast and no second serializer to keep in sync.
 */
export type PublicListingSource = Pick<
  ListingRow,
  "id" | "title" | "story" | "category" | "place_name" | "admin1" | "country" | "status" | "published_at" | "given_at"
>;

/** Row shape selected by `src/routes/feed.ts`'s three query modes — a subset
 * of `ListingRow`'s columns (never the owner-only ones) plus `lat`/`lng`,
 * which the feed needs for the geo mode's haversine filter but never
 * serializes onto `PublicListing` directly (only the derived `distance_mi`
 * is public). */
export interface FeedListingRow {
  id: string;
  title: string;
  story: string;
  category: string;
  country: string;
  place_name: string;
  admin1: string | null;
  status: string;
  lat: number;
  lng: number;
  published_at: number | null;
  given_at: number | null;
}

/**
 * `aspects` defaults to `[]` (not required) so the many call sites that
 * don't touch aspects on a given request (given/withdraw/relist) can still
 * compile without threading a fetch through — but every route that *reads*
 * a listing for display should still fetch and pass the real rows via
 * `fetchAspectRows`/`fetchAspectRowsForListings` (lib/listingsDb.ts); an
 * omitted argument here silently shows "no aspects" instead of a fetch bug,
 * which is a real (if quiet) way to reintroduce the exact failure mode #40
 * is about — a listing whose aspects vanished from the one place they were
 * supposed to be visible. Nothing about this default makes a listing
 * *invisible*; it only makes its aspects list rendered as empty.
 */
export function serializePublicListing(row: PublicListingSource, photos: PhotoRow[], aspects: Aspect[] = [], distanceMi?: number): PublicListing {
  return {
    id: row.id,
    title: row.title,
    story: row.story,
    category: row.category as Category,
    place_name: row.place_name,
    admin1: row.admin1,
    country: row.country as Country,
    status: row.status as "approved" | "given",
    photos: photos.map(serializePhoto),
    published_at: row.published_at ?? 0,
    ...(row.given_at !== null ? { given_at: row.given_at } : {}),
    aspects,
    // Rounded to 1 decimal place per the plan — the haversine result has
    // more precision than is meaningful to show ("2.3 mi", not
    // "2.31871... mi").
    ...(distanceMi !== undefined ? { distance_mi: Math.round(distanceMi * 10) / 10 } : {}),
  };
}

export function serializeOwnerListing(row: ListingRow, photos: PhotoRow[], aspects: Aspect[] = []): OwnerListing {
  return {
    id: row.id,
    title: row.title,
    story: row.story,
    category: row.category as Category,
    place_name: row.place_name,
    admin1: row.admin1,
    country: row.country as Country,
    status: row.status as ListingStatus,
    photos: photos.map(serializePhoto),
    published_at: row.published_at ?? 0,
    ...(row.given_at !== null ? { given_at: row.given_at } : {}),
    aspects,
    postal_code: row.postal_code,
    moderation_reason: (row.moderation_reason as ModerationReasonCode | null) ?? null,
    request_count: row.request_count,
    chosen_request_id: row.chosen_request_id,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    held: row.status === "needs_review",
  };
}

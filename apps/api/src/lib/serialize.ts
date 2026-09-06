/**
 * Row → API-shape mapping, kept in one place so `PublicListing`/`OwnerListing`
 * (both from `@keepsake/contracts/listing`) are always built the same way
 * regardless of which route is assembling them.
 */
import type { PublicPhoto } from "@keepsake/contracts/photo";
import type { Category, ListingStatus, ModerationReasonCode, OwnerListing, PublicListing } from "@keepsake/contracts/listing";
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

export function serializePublicListing(row: ListingRow, photos: PhotoRow[]): PublicListing {
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
  };
}

export function serializeOwnerListing(row: ListingRow, photos: PhotoRow[]): OwnerListing {
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

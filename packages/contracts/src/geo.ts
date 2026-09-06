/**
 * Postcode + radius search, US/CA/GB only (the settled M0 scope — see the
 * plan). No geocoding API: `postal_codes` is a bundled GeoNames table, looked
 * up by the normalized code this module produces.
 */
import { z } from "zod";

export const COUNTRIES = ["US", "CA", "GB"] as const;
export type Country = (typeof COUNTRIES)[number];
export const CountrySchema = z.enum(COUNTRIES);

export const COUNTRY_LABELS: Record<Country, string> = {
  US: "United States",
  CA: "Canada",
  GB: "United Kingdom",
};

/** Shown as placeholder/help text next to the postcode field. */
export const COUNTRY_POSTCODE_HINTS: Record<Country, string> = {
  US: "5-digit ZIP code",
  CA: "Postal code, e.g. M5V 3L9",
  GB: "Postcode, e.g. SW1A 1AA",
};

/**
 * Normalizes a raw postcode to the granularity we actually store/index:
 *   US — 5-digit ZIP (drops any +4 suffix)
 *   CA — Forward Sortation Area: first 3 chars, uppercased
 *   GB — outward code: the part before the space, or (no space given) the
 *        leading 2-4 chars that look like an outward code
 * Returns null when the input doesn't match the shape for that country.
 */
export function normalizePostalCode(country: Country, raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  if (country === "US") {
    const m = /^\d{5}/.exec(trimmed);
    return m ? m[0] : null;
  }

  if (country === "CA") {
    const upper = trimmed.toUpperCase();
    const m = /^[A-Z]\d[A-Z]/.exec(upper);
    return m ? m[0] : null;
  }

  // GB
  const upper = trimmed.toUpperCase();
  const spaceIdx = upper.indexOf(" ");
  if (spaceIdx > 0) {
    const outward = upper.slice(0, spaceIdx);
    return /^[A-Z]{1,2}\d[A-Z\d]?$/.test(outward) ? outward : null;
  }
  const m = /^[A-Z]{1,2}\d[A-Z\d]?/.exec(upper);
  return m ? m[0] : null;
}

export const PostalLookup = z.object({
  country: CountrySchema,
  code: z.string(),
  place_name: z.string(),
  admin1: z.string().nullable(),
  lat: z.number(),
  lng: z.number(),
});
export type PostalLookup = z.infer<typeof PostalLookup>;

export type LatLng = { lat: number; lng: number };

const EARTH_RADIUS_MI = 3958.7613;

export function haversineMiles(a: LatLng, b: LatLng): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));

  return EARTH_RADIUS_MI * c;
}

export type BoundingBox = {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
};

/** ~69 mi per degree of latitude; longitude degrees shrink by cos(lat). */
export function boundingBox(lat: number, lng: number, radiusMi: number): BoundingBox {
  const MI_PER_DEG_LAT = 69.0;
  const latDelta = radiusMi / MI_PER_DEG_LAT;
  const cos = Math.cos((lat * Math.PI) / 180);
  const lngDelta = radiusMi / (MI_PER_DEG_LAT * (cos === 0 ? 1 : cos));

  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLng: lng - lngDelta,
    maxLng: lng + lngDelta,
  };
}

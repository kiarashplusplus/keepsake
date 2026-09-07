/**
 * Postcode + radius search, US/CA only.
 *
 * GB was removed from `COUNTRIES` on 2026-09-06 as part of a deliberate
 * decision to geo-block the UK for launch rather than take on Online Safety
 * Act duties (see `docs/runbooks/uk-block.md`). The visitor-facing block
 * lives in `apps/api/src/middleware/ukBlock.ts`; this file is the other half
 * — GB is no longer an accepted `country` for a listing or a postcode
 * lookup at all, blocked or not. The `postal_codes` table's GB rows and
 * `tools/geodata/build-postal-seed.mjs`'s GB support are both left in place
 * on purpose: they're inert without `"GB"` in `COUNTRIES`, and keeping them
 * is what makes re-adding GB later (a real Online Safety Act risk
 * assessment done, or legal advice that changes the calculus) a small,
 * additive change instead of a rebuild.
 *
 * No geocoding API: `postal_codes` is a bundled GeoNames table, looked up by
 * the normalized code this module produces.
 */
import { z } from "zod";

export const COUNTRIES = ["US", "CA"] as const;
export type Country = (typeof COUNTRIES)[number];
export const CountrySchema = z.enum(COUNTRIES);

export const COUNTRY_LABELS: Record<Country, string> = {
  US: "United States",
  CA: "Canada",
};

/** Shown as placeholder/help text next to the postcode field. */
export const COUNTRY_POSTCODE_HINTS: Record<Country, string> = {
  US: "5-digit ZIP code",
  CA: "Postal code, e.g. M5V 3L9",
};

/**
 * Normalizes a raw postcode to the granularity we actually store/index:
 *   US — 5-digit ZIP (drops any +4 suffix)
 *   CA — Forward Sortation Area: first 3 chars, uppercased
 * Returns null when the input doesn't match the shape for that country.
 */
export function normalizePostalCode(country: Country, raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  if (country === "US") {
    const m = /^\d{5}/.exec(trimmed);
    return m ? m[0] : null;
  }

  // CA
  const upper = trimmed.toUpperCase();
  const m = /^[A-Z]\d[A-Z]/.exec(upper);
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

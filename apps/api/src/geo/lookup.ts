import { normalizePostalCode, type Country, type PostalLookup } from "@keepsake/contracts/geo";
import type { Env } from "../env.js";

interface PostalCodeRow {
  country: string;
  code: string;
  place_name: string;
  admin1: string | null;
  lat: number;
  lng: number;
}

/**
 * Normalizes `rawCode` per the country-specific rule in
 * `normalizePostalCode` (this must stay in lockstep with
 * `tools/geodata/build-postal-seed.mjs`, which normalizes the same way when
 * building the seed — see `docs/design/geo.md`), then looks it up in the
 * `postal_codes` table seeded by that tool. Returns `null` for an
 * unrecognized shape or a code the seed doesn't cover.
 */
export async function lookupPostalCode(env: Env, country: Country, rawCode: string): Promise<PostalLookup | null> {
  const normalized = normalizePostalCode(country, rawCode);
  if (!normalized) return null;

  const row = await env.DB.prepare(
    "SELECT country, code, place_name, admin1, lat, lng FROM postal_codes WHERE country = ? AND code = ?",
  )
    .bind(country, normalized)
    .first<PostalCodeRow>();

  if (!row) return null;

  return {
    country: row.country as Country,
    code: row.code,
    place_name: row.place_name,
    admin1: row.admin1,
    lat: row.lat,
    lng: row.lng,
  };
}

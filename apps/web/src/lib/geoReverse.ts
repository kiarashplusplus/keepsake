/**
 * Resolve a postcode (and, where the provider says, a country) from
 * geographic coordinates — keyless, client-side, and never sent to our own
 * API. Ported nearly verbatim from Finderly's `frontend/src/utils/
 * reverseGeocode.ts`: BigDataCloud first (no key, generous free tier),
 * falling back to OpenStreetMap Nominatim if BigDataCloud is unreachable or
 * doesn't return a postcode.
 *
 * On a network failure, browsers surface an opaque message ("Load failed"
 * on iOS Safari, "Failed to fetch" on Chrome) — this catches that, tries
 * the fallback, and only ever surfaces one actionable error if BOTH
 * providers fail, so a transient outage of one provider alone never breaks
 * postcode autofill.
 *
 * Unlike the Finderly original (US ZIP only), this also reads a country
 * code off the response — Keepsake supports more than one country — but
 * doesn't otherwise decide whether that country is one we support; that's
 * the caller's call against the real `COUNTRIES` list.
 */

const BIGDATACLOUD_HOST = "api.bigdatacloud.net";
const NOMINATIM_HOST = "nominatim.openstreetmap.org";

// Exported so a caller can show this exact, designed-for-users copy while
// replacing every other (raw) error with its own friendly fallback.
export const MANUAL_ENTRY_MESSAGE = "Couldn't work out your postcode — type it in.";

export type ReverseGeocodeResult = {
  postcode: string;
  /** ISO 3166-1 alpha-2, uppercased, as reported by the provider — may not
   * be a country we support; the caller decides. `null` when the provider
   * didn't say. */
  countryCode: string | null;
};

function extractPostcode(data: any): string | undefined {
  return data?.postcode || data?.postalCode || data?.zip || data?.zipcode || data?.address?.postcode;
}

function extractCountryCode(data: any): string | undefined {
  return data?.countryCode || data?.country_code || data?.address?.country_code;
}

function normalizePostcode(value: unknown): string {
  return String(value).trim();
}

function normalizeCountryCode(value: unknown): string | null {
  const code = String(value).trim().toUpperCase();
  return code.length > 0 ? code : null;
}

function toResult(data: any): ReverseGeocodeResult | null {
  const postcode = extractPostcode(data);
  if (!postcode) return null;
  const countryCode = extractCountryCode(data);
  return { postcode: normalizePostcode(postcode), countryCode: countryCode ? normalizeCountryCode(countryCode) : null };
}

async function lookupFromBigDataCloud(lat: number, lon: number): Promise<ReverseGeocodeResult | null> {
  const url = `https://${BIGDATACLOUD_HOST}/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`BigDataCloud HTTP ${res.status}`);
  const data: unknown = await res.json();
  return toResult(data);
}

async function lookupFromNominatim(lat: number, lon: number): Promise<ReverseGeocodeResult | null> {
  const url = `https://${NOMINATIM_HOST}/reverse?format=jsonv2&lat=${lat}&lon=${lon}&addressdetails=1&accept-language=en`;
  // Nominatim's usage policy asks for an identifying User-Agent. Browsers
  // drop this forbidden header silently (and send a Referer instead), but
  // it costs nothing to send.
  const res = await fetch(url, { headers: { "User-Agent": "Keepsake/1.0 (postcode autofill)" } });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const data: unknown = await res.json();
  return toResult(data);
}

/**
 * Reverse-geocodes coordinates to a postcode (+ country code where
 * reported), trying BigDataCloud then OpenStreetMap Nominatim. Throws
 * `MANUAL_ENTRY_MESSAGE` only when both providers fail to produce a
 * postcode.
 */
export async function reverseGeocode(lat: number, lon: number): Promise<ReverseGeocodeResult> {
  try {
    const result = await lookupFromBigDataCloud(lat, lon);
    if (result) return result;
    // No postcode in the response — try the fallback before giving up.
  } catch (primaryErr) {
    // BigDataCloud unreachable/errored — fall through to the fallback.
    if (typeof console !== "undefined") {
      console.warn("[reverseGeocode] BigDataCloud failed, trying Nominatim:", primaryErr);
    }
  }

  try {
    const result = await lookupFromNominatim(lat, lon);
    if (result) return result;
  } catch (fallbackErr) {
    if (typeof console !== "undefined") {
      console.warn("[reverseGeocode] Nominatim fallback failed:", fallbackErr);
    }
  }

  throw new Error(MANUAL_ENTRY_MESSAGE);
}

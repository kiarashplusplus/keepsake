/**
 * The feed's location preference: persisted client-side (via `prefStore`, a
 * plain user preference — not a secret) so a return visit reopens the same
 * search. Mirrors the API's two mutually-exclusive geo modes (`country` +
 * `postal`, or `lat` + `lng` from "Use my location") plus the radius chip,
 * which includes an "anywhere" option outside `RADIUS_OPTIONS`.
 */
import { RADIUS_OPTIONS, type RadiusMi } from "@keepsake/contracts/feed";
import { COUNTRIES, type Country } from "@keepsake/contracts/geo";
import { prefStore } from "@/lib/prefStore";

export const LOCATION_PREF_STORAGE_KEY = "keepsake.location.v1";

export type LocationMode = "postal" | "coords" | "none";
export type RadiusChoice = RadiusMi | "anywhere";

export type LocationPref = {
  mode: LocationMode;
  country: Country;
  postal: string;
  lat: number | null;
  lng: number | null;
  radius: RadiusChoice;
};

export const DEFAULT_LOCATION_PREF: LocationPref = {
  mode: "none",
  country: "US",
  postal: "",
  lat: null,
  lng: null,
  radius: 25,
};

function isCountry(value: unknown): value is Country {
  return typeof value === "string" && (COUNTRIES as readonly string[]).includes(value);
}

function isRadiusChoice(value: unknown): value is RadiusChoice {
  return value === "anywhere" || (RADIUS_OPTIONS as readonly number[]).includes(value as number);
}

function isLocationMode(value: unknown): value is LocationMode {
  return value === "postal" || value === "coords" || value === "none";
}

function isLocationPrefShape(value: unknown): value is Partial<LocationPref> {
  return typeof value === "object" && value !== null;
}

export function serializeLocationPref(pref: LocationPref): string {
  return JSON.stringify(pref);
}

export function deserializeLocationPref(raw: string): LocationPref | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isLocationPrefShape(parsed)) return null;
    return {
      mode: isLocationMode(parsed.mode) ? parsed.mode : DEFAULT_LOCATION_PREF.mode,
      country: isCountry(parsed.country) ? parsed.country : DEFAULT_LOCATION_PREF.country,
      postal: typeof parsed.postal === "string" ? parsed.postal : DEFAULT_LOCATION_PREF.postal,
      lat: typeof parsed.lat === "number" ? parsed.lat : null,
      lng: typeof parsed.lng === "number" ? parsed.lng : null,
      radius: isRadiusChoice(parsed.radius) ? parsed.radius : DEFAULT_LOCATION_PREF.radius,
    };
  } catch {
    return null;
  }
}

export async function loadLocationPref(): Promise<LocationPref> {
  const raw = await prefStore.getItem(LOCATION_PREF_STORAGE_KEY);
  if (raw === null) return DEFAULT_LOCATION_PREF;
  return deserializeLocationPref(raw) ?? DEFAULT_LOCATION_PREF;
}

export async function saveLocationPref(pref: LocationPref): Promise<void> {
  await prefStore.setItem(LOCATION_PREF_STORAGE_KEY, serializeLocationPref(pref));
}

/** "0.8 mi", "12 mi" — one decimal place under 10 miles, whole miles above
 * (a listing's own precision doesn't warrant more). */
export function formatDistance(miles: number): string {
  if (miles < 10) return `${Math.round(miles * 10) / 10} mi`;
  return `${Math.round(miles)} mi`;
}

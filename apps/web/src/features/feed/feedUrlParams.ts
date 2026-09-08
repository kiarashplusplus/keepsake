/**
 * URL <-> feed-query mapping so a shared feed link reproduces the same view
 * (`app/index.tsx` reads/writes these via expo-router's
 * `useLocalSearchParams`/`router.setParams`). Deliberately covers only
 * `q`/`category`/`country`/`postal`/`radius_mi` — never `lat`/`lng`, which
 * come from "Use my location" and would otherwise put a visitor's exact
 * coordinates in a link they paste somewhere.
 */
import { RADIUS_OPTIONS, type RadiusMi } from "@keepsake/contracts/feed";
import { CATEGORIES, type Category } from "@keepsake/contracts/listing";
import { COUNTRIES, type Country } from "@keepsake/contracts/geo";

export type FeedUrlParams = {
  q: string | undefined;
  category: string | undefined;
  country: string | undefined;
  postal: string | undefined;
  radius_mi: string | undefined;
};

export type FeedUrlQuery = {
  q?: string;
  category?: Category;
  country?: Country;
  postal?: string;
  radius_mi?: RadiusMi;
};

function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

function isCountry(value: string): value is Country {
  return (COUNTRIES as readonly string[]).includes(value);
}

function isRadiusMi(value: number): value is RadiusMi {
  return (RADIUS_OPTIONS as readonly number[]).includes(value);
}

/** A raw URL param can be `string | string[] | undefined` per expo-router's
 * `useLocalSearchParams` — take the first value of an array (a legitimate
 * `?category=a&category=b` is nonsensical here) and drop empty strings. */
function first(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw !== undefined && raw !== "" ? raw : undefined;
}

/** Parses raw, possibly-untrusted URL params into a validated feed query.
 * Anything that doesn't match the contracts' enums/options is dropped rather
 * than throwing — a stale or hand-edited URL should degrade to "no filter",
 * not break the page. */
export function feedQueryFromUrlParams(params: Record<string, string | string[] | undefined>): FeedUrlQuery {
  const query: FeedUrlQuery = {};

  const q = first(params.q);
  if (q !== undefined) query.q = q;

  const category = first(params.category);
  if (category !== undefined && isCategory(category)) query.category = category;

  const country = first(params.country);
  if (country !== undefined && isCountry(country)) query.country = country;

  const postal = first(params.postal);
  if (postal !== undefined) query.postal = postal;

  const radiusRaw = first(params.radius_mi);
  if (radiusRaw !== undefined) {
    const radius = Number(radiusRaw);
    if (isRadiusMi(radius)) query.radius_mi = radius;
  }

  return query;
}

/** The inverse for `router.setParams`. Every managed field is present: Expo
 * Router removes a stale query-string key only when its replacement is
 * explicitly `undefined`, so omitting an inactive filter would leave the old
 * value in the address bar and make it come back after a reload. */
export function urlParamsFromFeedQuery(query: FeedUrlQuery): FeedUrlParams {
  return {
    q: query.q,
    category: query.category,
    country: query.country,
    postal: query.postal,
    radius_mi: query.radius_mi !== undefined ? String(query.radius_mi) : undefined,
  };
}

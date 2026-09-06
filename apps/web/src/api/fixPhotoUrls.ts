/**
 * Contract gap, not a style choice: `PublicPhoto.url_full`/`url_thumb`
 * (`@keepsake/contracts/photo`) are typed `z.string().url()` — an absolute
 * URL. `apps/api`'s current serializer (`src/lib/serialize.ts`,
 * `src/routes/photos.ts`) emits origin-relative paths instead
 * (`/i/<id>/full`), confirmed by seeding a listing into a local `wrangler
 * dev` D1 and inspecting the raw `/api/feed` response while verifying this
 * milestone. A relative path fails `.url()`, so every API wrapper below that
 * calls `PublicPhoto.parse()` (transitively, via `PublicListing`/
 * `OwnerListing`/`OwnerListingDetail`) would throw on every real response
 * instead of just on a genuinely malformed one.
 *
 * This resolves any relative `url_full`/`url_thumb` against `config.siteUrl`
 * (or `window.location.origin`) before validation, so the client tolerates
 * either shape and a same-origin deploy (preview/production, where the
 * Worker serves both the API and the SPA) never actually breaks. It is
 * intentionally NOT a fix to the root cause — that's either the API
 * serializing absolute URLs or the contract accepting a relative path — and
 * is called out in the task report as something the API/contracts side
 * should reconcile.
 */
import { config } from "@/lib/config";

function resolveMediaUrl(raw: string): string {
  if (/^https?:\/\//i.test(raw)) return raw;
  const origin = config.siteUrl || (typeof window !== "undefined" ? window.location.origin : "");
  return `${origin}${raw.startsWith("/") ? "" : "/"}${raw}`;
}

function withResolvedPhotoUrls(photo: Record<string, unknown>): Record<string, unknown> {
  return {
    ...photo,
    ...(typeof photo.url_full === "string" ? { url_full: resolveMediaUrl(photo.url_full) } : {}),
    ...(typeof photo.url_thumb === "string" ? { url_thumb: resolveMediaUrl(photo.url_thumb) } : {}),
  };
}

/**
 * Walks an API response of unknown shape and resolves any `url_full`/
 * `url_thumb` it finds, at any of the three places they can appear in this
 * API's responses: a bare `PublicPhoto`, a listing's `photos` array, or a
 * feed page's `items` array of listings (or a plain array of listings, as
 * from `GET /api/me/listings`). Called on the raw JSON *before* the
 * contracts' zod schema validates it.
 */
export function fixPhotoUrls(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(fixPhotoUrls);
  if (typeof data !== "object" || data === null) return data;

  const obj = data as Record<string, unknown>;

  if (typeof obj.url_full === "string" || typeof obj.url_thumb === "string") {
    return withResolvedPhotoUrls(obj);
  }
  if (Array.isArray(obj.photos)) {
    return { ...obj, photos: obj.photos.map(fixPhotoUrls) };
  }
  if (Array.isArray(obj.items)) {
    return { ...obj, items: obj.items.map(fixPhotoUrls) };
  }
  return data;
}

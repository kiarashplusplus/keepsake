/**
 * Purges a photo's two variant URLs from `caches.default`, the Workers-level
 * edge cache `src/routes/images.ts` populates for publicly-served photos
 * (issue #22).
 *
 * `GET /i/:id/:variant` already re-reads the listing's status from D1 on
 * every single request and only ever consults the cache *after* confirming,
 * fresh, that the photo is currently public — so a request made after a
 * photo's row is deleted or its listing's status changes away from
 * `approved`/`given` can never be answered from a stale cache entry through
 * that route; it 404s before the cache is ever touched. Verified directly
 * against `wrangler dev` for this issue (see the closing comment on #22):
 * approved a listing, fetched its photo twice (second response carried
 * `CF-Cache-Status: HIT`, confirming the entry was real), then tried both
 * ways a photo stops being public — `DELETE /api/listings/:id` (R2 object
 * gone) and `POST .../withdraw` (row stays, status changes, *no* purge call
 * on this path) — and both turned the exact same cached URL into a 404 on
 * the very next request, not the cached bytes.
 *
 * The real, unfixable-by-purge exposure is everything *outside* Cloudflare's
 * control: the response used to be served `Cache-Control: public,
 * max-age=31536000, immutable` (now `public, max-age=3600` — see
 * `images.ts`), so any stranger's browser, and any other public/shared cache
 * the request passed through, was entitled to keep its own copy for as long
 * as that header said, with zero revalidation, regardless of what happens to
 * `caches.default`. Nothing server-side can reach into a browser's cache.
 * Shortening the lifetime (done) bounds that window; this purge is the other
 * half —
 * defense in depth against `caches.default` itself serving a stale copy on
 * *this* code path if a future change ever moves the cache check ahead of
 * the DB read, and against any colo where a `cache.put()` from
 * `images.ts`'s `waitUntil` lands after the delete already committed
 * (`sweepTerminalListingPhotos` in particular runs long after the listing
 * went non-public, so this only ever removes an entry nothing could reach
 * anyway — it's still done because "unreachable today" is not a proof that
 * stays true across every future change to `images.ts`).
 *
 * One more scope note (issue #94): `cache.delete()` here only reaches the
 * colo that happens to execute *this* request — `caches.default` is local to
 * each Cloudflare data center, not one cache shared across the network. A
 * copy served from a different colo (a browser on another continent, say) is
 * untouched by this call and only expires on its own via the TTL above. A
 * true every-colo purge needs Cloudflare's zone-level Purge Cache API, which
 * needs a zone attached to a domain and an API token scoped to it — neither
 * exists yet (`keepsake.ing` isn't attached to a zone; see #46), so that half
 * is `blocked-on-kiarash` on #94, not implemented here.
 *
 * Not called from `orphanSweep.ts`'s `sweepOrphanPhotos`: those rows never
 * had a `listing_id`, so `isPublic` was false for every request that ever
 * saw them and `images.ts` never put them in the cache in the first place.
 */
import type { Env } from "../env.js";

export async function purgePhotoCache(env: Env, photoId: string): Promise<void> {
  const cache = (caches as unknown as Record<"default", Cache>).default;
  await Promise.all(
    (["full", "thumb"] as const).map((variant) => cache.delete(new Request(`${env.SITE_URL}/i/${photoId}/${variant}`))),
  );
}

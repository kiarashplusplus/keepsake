/**
 * Purges a photo's two variant URLs from Cloudflare's caches — first from
 * `caches.default`, the Workers-level cache `src/routes/images.ts` populates
 * for publicly-served photos (issue #22), then, when the zone credentials
 * are configured, from every colo at once via the zone-level Purge Cache API
 * (issue #94).
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
 * as that header said, with zero revalidation, regardless of what happens
 * inside Cloudflare. Nothing server-side can reach into a browser's cache.
 * Shortening the lifetime (done) bounds that window; these purges are the
 * other half —
 * defense in depth against a Cloudflare-held copy serving stale bytes on
 * *this* code path if a future change ever moves the cache check ahead of
 * the DB read, and against any colo where a `cache.put()` from
 * `images.ts`'s `waitUntil` lands after the delete already committed
 * (`sweepTerminalListingPhotos` in particular runs long after the listing
 * went non-public, so this only ever removes an entry nothing could reach
 * anyway — it's still done because "unreachable today" is not a proof that
 * stays true across every future change to `images.ts`).
 *
 * Two mechanisms, two different reaches — the distinction issue #94 is
 * about, so don't let either comment below drift back into "purges
 * Cloudflare's edge cache" unqualified:
 *
 *  1. `cache.delete()` reaches **only the colo that happens to execute this
 *     request**. `caches.default` is local to each Cloudflare data center,
 *     not one cache shared across the network, so a copy held at any other
 *     colo is untouched by it.
 *  2. `POST /zones/:zone_id/purge_cache` reaches **every colo**, which is
 *     the only way to close (1)'s gap. It needs a zone (`keepsake.ing`,
 *     attached 2026-09-07) and an API token scoped to `Zone.Cache Purge` on
 *     it. Both arrive as configuration, and both are frequently absent —
 *     local dev, the e2e suite and any preview without the secret — so the
 *     call is skipped silently in that case rather than logged, because it
 *     would otherwise log on literally every delete in every one of those
 *     environments.
 *
 * When (2) is unconfigured, (1) is still the whole purge and the residual
 * exposure is bounded, not open: `images.ts` serves `max-age=3600`, so a
 * copy at an unreached colo expires within the hour on its own. That bound
 * is why this was never an active leak and why an unconfigured no-op is an
 * acceptable state to ship rather than a failure to raise.
 *
 * Nothing here is allowed to throw. Both call sites are on a path a person
 * is waiting on or a cron job that must keep going: `DELETE
 * /api/listings/:id` must still succeed when Cloudflare's API is down or
 * slow, and the terminal-photo sweep must not abort a batch over one failed
 * purge. Failures are reported through `@keepsake/observability/capture`
 * (Workers Logs) instead of being swallowed — a purge that has been quietly
 * failing for a month is the same as not having one.
 *
 * Not called from `orphanSweep.ts`'s `sweepOrphanPhotos`: those rows never
 * had a `listing_id`, so `isPublic` was false for every request that ever
 * saw them and `images.ts` never put them in the cache in the first place.
 */
import { captureException, captureMessage } from "@keepsake/observability/capture";
import type { Env } from "../env.js";

const PHOTO_VARIANTS = ["full", "thumb"] as const;

/** How long to give Cloudflare's API before giving up. The delete path is
 * user-facing; a hung purge must not hold a request (or a `waitUntil`, whose
 * budget the Worker shares) open indefinitely. */
const ZONE_PURGE_TIMEOUT_MS = 5000;

export async function purgePhotoCache(env: Env, photoId: string): Promise<void> {
  const urls = PHOTO_VARIANTS.map((variant) => `${env.SITE_URL}/i/${photoId}/${variant}`);

  // (1) The colo executing *this* request only — see the header comment.
  const cache = (caches as unknown as Record<"default", Cache>).default;
  await Promise.all(urls.map((url) => cache.delete(new Request(url))));

  // (2) Every colo, when the zone credentials are configured.
  await purgeZoneCache(env, urls, photoId);
}

/**
 * `POST /zones/:zone_id/purge_cache` with both variant URLs in one call —
 * one API request per photo rather than one per variant, which matters for
 * the terminal-photo sweep (up to 100 photos per batch) far more than it
 * does for a single interactive delete.
 *
 * Returns normally in every case, including failure. The `void` is load
 * bearing: a rejected promise here would reject the `Promise.all`/`await` at
 * both call sites and turn a best-effort cache purge into a failed listing
 * delete.
 */
async function purgeZoneCache(env: Env, urls: string[], photoId: string): Promise<void> {
  // `wrangler types` narrows a `[vars]` entry to the literal currently in
  // `wrangler.toml` (`CF_ZONE_ID = ""` in the dev block), so widen it back
  // to `string` the same way `env.ts`'s `isMockAi`/`isProduction` do. The
  // token is a Worker secret (`src/secrets.d.ts`), already optional.
  const zoneId = (env.CF_ZONE_ID as string | undefined)?.trim();
  const token = env.CF_CACHE_PURGE_TOKEN?.trim();

  // The no-op. Deliberately silent: local dev, `vitest`, Playwright and any
  // preview deployed without the secret all land here on every single
  // delete, and a log line on each would be noise that trains people to
  // ignore this module's logs — which are what a *real* purge failure has
  // to be seen through.
  if (!zoneId || !token) return;

  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ files: urls }),
      signal: AbortSignal.timeout(ZONE_PURGE_TIMEOUT_MS),
    });

    // Cloudflare's v4 envelope is the authority on whether the purge was
    // accepted, not the status code alone — so a 200 whose body doesn't say
    // `"success": true` counts as a failure here rather than as a purge
    // that silently didn't happen. A body that isn't JSON at all (an edge
    // error page, a proxy interposing) fails the same way, on purpose.
    const body = await response.text().catch(() => "");
    let succeeded = response.ok;
    if (succeeded) {
      try {
        succeeded = (JSON.parse(body) as { success?: unknown }).success === true;
      } catch {
        succeeded = false;
      }
    }

    if (!succeeded) {
      captureMessage(`Cloudflare zone cache purge failed for photo ${photoId}`, "warning", {
        tags: { component: "photoCache", status: response.status },
        // The response body carries Cloudflare's own `errors[]` (bad token,
        // wrong zone, URL outside the zone), which is the only thing that
        // says *why*. Truncated: a purge failure is not worth an unbounded
        // log line. `capture` redacts before writing either way.
        extra: { zoneId, urls, body: body.slice(0, 500) },
      });
    }
  } catch (error) {
    // Network failure, DNS, or the timeout above. Same rule as a non-2xx:
    // report it, never rethrow it at the caller.
    captureException(error, {
      tags: { component: "photoCache" },
      extra: { zoneId, urls, photoId },
    });
  }
}

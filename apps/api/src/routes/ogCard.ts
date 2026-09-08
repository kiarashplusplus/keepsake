/**
 * `GET /og/item/:id/card.png` — the designed share card for a listing, as a
 * 1200x630 JPEG.
 *
 * This is what a friend sees when a keepsake.ing link unfurls in iMessage,
 * WhatsApp or Slack, and it is the same artifact the give flow shows the
 * giver so they know what they are about to send. `routes/item.ts` points
 * `og:image` here.
 *
 * ## Two names that are deliberately not what they look like
 *
 * **`card.png` serves a JPEG.** The path is a suffix, not a content
 * negotiation: unfurlers key their caches on the URL and some are unhappy
 * with an extensionless image path, while the *format* is chosen by the
 * `Content-Type` header, which is honest about being `image/jpeg`. Renaming
 * the path would change every `og:image` URL already cached by WhatsApp and
 * Facebook for zero benefit. See `og/render.ts` for why JPEG (the same card
 * is 377-536 KB as a PNG and 81-98 KB as a JPEG).
 *
 * **A trailing static segment, not `/og/item/:id.png`.** Hono's param
 * matching against a literal suffix inside one segment is a footgun; a
 * separate final segment is unambiguous.
 *
 * ## Visibility
 *
 * Mirrors `routes/images.ts`: public only when the listing is `approved` or
 * `given`, and everything else is a 404 rather than a 403, so the route never
 * confirms that an id exists to someone who cannot see it.
 *
 * **One deliberate divergence: there is no owner-token preview here.**
 * `images.ts` grants owners a look at their own unapproved photos because the
 * give flow needs to render them while moderation runs. The card is only ever
 * shown once a listing is already `approved` (the "It's live." state), so an
 * owner bypass would be pure extra surface on the most widely redistributed
 * artifact this product emits. Do not add one back without a use for it.
 *
 * ## Caching
 *
 * Three layers after the visibility check: `caches.default` -> R2 -> render.
 * The check is deliberately NOT behind the cache — see the handler. The R2 key
 * is content-addressed (`og/fingerprint.ts`), so nothing is ever invalidated;
 * an edit produces a new key and a new `?v=`. `X-Keepsake-OG` reports which
 * layer answered — `edge`, `r2` or `render` — which is what makes the
 * "renders once" claim testable rather than assumed.
 *
 * The `?v=` fingerprint `routes/item.ts` puts on the URL is **advisory and
 * never a selector**: it exists to bust WhatsApp's and Facebook's own
 * URL-keyed unfurl caches, which expose no flush. A request carrying a stale
 * or absent `v` still gets the current card. It does change the edge-cache
 * key, though, which is the seam the tests use to exercise the R2 layer.
 *
 * ## Failure
 *
 * Never a 500 if there are bytes to serve. Rasterisation can fail for real
 * reasons — a WebP cover, which `lib/imageSniff.ts` accepts on upload even
 * though the official client always writes JPEG — so the route degrades:
 * card -> the raw cover photo -> the site-wide default card. It **streams**
 * the fallback rather than redirecting, because some unfurlers will not
 * follow a redirect for `og:image`. Every fallback is reported to
 * `captureException`; a fallback quietly firing for a month is the same as
 * having no card at all.
 */
import { Hono, type Context } from "hono";
import { captureException } from "@keepsake/observability/capture";
// `category.ts` is a leaf module with no subpath export of its own; every
// other call site reaches these through `/listing`, which re-exports them.
import { CATEGORY_LABELS, type Category } from "@keepsake/contracts/listing";
import type { Env } from "../env.js";
import { fetchListingRow } from "../lib/listingsDb.js";
import { requireParam } from "../lib/params.js";
import { fail } from "../lib/respond.js";
import { burst } from "../middleware/rateLimit.js";
import { cardFingerprint, placeLine } from "../og/fingerprint.js";
import { renderItemCard } from "../og/render.js";

type OgCardCtx = Context<{ Bindings: Env }>;

export const ogCardRoutes = new Hono<{ Bindings: Env }>();

/** Same one-hour bound `images.ts` uses, for the same issue-#22 reason: a
 * listing's *visibility* can be revoked even when its content cannot change,
 * and no purge reaches a stranger's browser cache. Not `immutable`. */
const CACHE_CONTROL = "public, max-age=3600";

interface CoverPhoto {
  id: string;
  r2_key_full: string;
  r2_key_thumb: string;
  width: number;
  height: number;
  content_type: string;
}

/**
 * The listing's first photo, with the R2 keys `fetchPhotoRows` does not
 * select. Ordered by `position` exactly as the item page's carousel is, so
 * the card's photo is the one a visitor sees first.
 */
async function fetchCoverPhoto(env: Env, listingId: string): Promise<CoverPhoto | null> {
  return env.DB.prepare(
    `SELECT id, r2_key_full, r2_key_thumb, width, height, content_type
     FROM photos WHERE listing_id = ? ORDER BY position LIMIT 1`,
  )
    .bind(listingId)
    .first<CoverPhoto>();
}

/**
 * Which stored variant to decode.
 *
 * The card's photo window is 444px on its long edge, so the 640px `thumb` is
 * always enough — and decoding it instead of the 2048px `full` is roughly a
 * tenth of the JPEG-decode work on the one path that actually costs CPU.
 *
 * The exception is a panorama: `width`/`height` on the row are the FULL
 * variant's, so a 16:9 photo's thumb is only 360px on its short edge and
 * would be upscaled into a square window. Fall back to `full` only then.
 */
const WINDOW_EDGE_PX = 444;
const THUMB_EDGE_PX = 640;

function pickVariant(photo: CoverPhoto): string {
  const longEdge = Math.max(photo.width, photo.height);
  const shortEdge = Math.min(photo.width, photo.height);
  if (longEdge === 0) return photo.r2_key_thumb;
  const thumbShortEdge = Math.round((shortEdge * THUMB_EDGE_PX) / longEdge);
  return thumbShortEdge < WINDOW_EDGE_PX ? photo.r2_key_full : photo.r2_key_thumb;
}

function imageResponse(body: BodyInit, contentType: string, extra: Record<string, string>): Response {
  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": CACHE_CONTROL,
    // A social artifact, not a page. `/i/:id/full` is the canonical image and
    // the one JSON-LD points at; this should not compete with it in search.
    "X-Robots-Tag": "noindex",
    ...extra,
  });
  return new Response(body, { headers });
}

ogCardRoutes.get("/item/:id/card.png", burst("RL_READ"), async (c) => {
  const id = requireParam(c, "id");

  // The visibility check comes FIRST, before the edge cache — the same order
  // `routes/images.ts` uses, and for the same reason. A card carries the
  // giver's photo, the story and the town; serving one from cache for an hour
  // after the listing was deleted, withdrawn or hidden is exactly the failure
  // `lib/photoCache.ts` exists to prevent for the photo itself. One D1 read
  // per request is the price of the listing's visibility being authoritative,
  // and the cache still saves the R2 fetch and the raster.
  const row = await fetchListingRow(c.env, id);
  if (row === null || (row.status !== "approved" && row.status !== "given")) {
    return fail(c, "not_found", "Not found.", 404);
  }

  const cache = (caches as unknown as Record<"default", Cache>).default;
  const cacheKey = new Request(c.req.url);
  const cached = await cache.match(cacheKey);
  if (cached) {
    // Re-stamp `X-Keepsake-OG`. A cache hit replays the response that was
    // stored, headers and all, so without this every edge hit reports the
    // layer that *originally* produced it — `render` forever, making the
    // header useless for the one thing it exists to answer ("did this render
    // again?"). Caught by the test that asserts a second request does not
    // re-render.
    const headers = new Headers(cached.headers);
    headers.set("X-Keepsake-OG", "edge");
    return new Response(cached.body, { status: cached.status, headers });
  }

  const photo = await fetchCoverPhoto(c.env, id);

  // No photo at all: serve the site-wide default card rather than rendering
  // an empty print. Rare (the give flow requires a photo) but reachable, since
  // `DELETE /api/photos/:id` can strip the last one from a live listing.
  if (photo === null) {
    return serveDefault(c, "no_photo");
  }

  const fingerprint = await cardFingerprint({
    id: row.id,
    version: row.version,
    status: row.status,
    title: row.title,
    story: row.story,
    place: placeLine(row.place_name, row.admin1),
    categoryLabel: CATEGORY_LABELS[row.category as Category] ?? row.category,
    coverPhotoId: photo.id,
  });
  const r2Key = `og/${id}/${fingerprint}.jpg`;

  const existing = await c.env.BUCKET.get(r2Key);
  if (existing) {
    const response = imageResponse(existing.body, "image/jpeg", { "X-Keepsake-OG": "r2" });
    c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }

  const object = await c.env.BUCKET.get(pickVariant(photo));
  if (object === null) {
    // The row says there is a photo and R2 disagrees. That is a real
    // inconsistency worth knowing about, not a routine miss.
    captureException(new Error("og card cover photo missing from R2"), {
      tags: { component: "ogCard" },
      extra: { listingId: id, photoId: photo.id },
    });
    return serveDefault(c, "cover_missing");
  }
  const coverBytes = new Uint8Array(await object.arrayBuffer());

  let jpeg: Uint8Array<ArrayBuffer>;
  try {
    jpeg = await renderItemCard({
      id: row.id,
      title: row.title,
      story: row.story,
      categoryLabel: CATEGORY_LABELS[row.category as Category] ?? row.category,
      place: placeLine(row.place_name, row.admin1),
      status: row.status === "given" ? "given" : "approved",
      cover: coverBytes,
    });
  } catch (error) {
    // Most likely a WebP cover: resvg decodes JPEG, PNG and GIF only. Serving
    // the raw photo is worse than a card and far better than a broken image.
    captureException(error, {
      tags: { component: "ogCard" },
      extra: { listingId: id, photoId: photo.id, contentType: photo.content_type },
    });
    return imageResponse(coverBytes, object.httpMetadata?.contentType ?? photo.content_type, {
      "X-Keepsake-OG": "render",
      "X-Keepsake-OG-Fallback": "photo",
    });
  }

  const response = imageResponse(jpeg, "image/jpeg", { "X-Keepsake-OG": "render" });
  c.executionCtx.waitUntil(
    Promise.all([
      c.env.BUCKET.put(r2Key, jpeg, { httpMetadata: { contentType: "image/jpeg" } }),
      cache.put(cacheKey, response.clone()),
    ]),
  );
  return response;
});

/**
 * The site-wide default card, read from the static assets the Worker already
 * serves. Streamed, not redirected — see the file header.
 */
async function serveDefault(c: OgCardCtx, reason: string): Promise<Response> {
  const asset = await c.env.ASSETS.fetch(new Request(new URL("/og-default.png", c.req.url)));
  if (!asset.ok) return fail(c, "not_found", "Not found.", 404);
  return imageResponse(asset.body as BodyInit, "image/png", {
    "X-Keepsake-OG": "default",
    "X-Keepsake-OG-Fallback": reason,
  });
}

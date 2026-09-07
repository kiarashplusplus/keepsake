/**
 * `GET /i/:id/:variant` — public photo serving through the edge cache.
 * Mounted at the Worker root (not under `/api`), per the plan's route table.
 *
 * A photo is servable to a stranger once its listing is `approved`/`given`.
 * Before that (orphan, `pending`, `needs_review`, `rejected`, `withdrawn`,
 * `hidden`) only the owner — previewing their own submission while it's
 * being reviewed — may fetch it, proven the same way every owner route
 * proves it: a valid `Authorization: Bearer ks_...` token for that owner.
 * Anyone else gets a 404, not a 403 — this endpoint never confirms a photo
 * id exists to someone who can't see it.
 */
import { Hono, type Context } from "hono";
import { OwnerTokenSchema } from "@keepsake/contracts/owner";
import type { Env } from "../env.js";
import { fail } from "../lib/respond.js";
import { sha256Hex } from "../lib/digest.js";
import { burst } from "../middleware/rateLimit.js";

type ImageCtx = Context<{ Bindings: Env }>;

export const imageRoutes = new Hono<{ Bindings: Env }>();

interface PhotoRow {
  id: string;
  owner_id: string;
  listing_id: string | null;
  r2_key_full: string;
  r2_key_thumb: string;
  content_type: string;
  listing_status: string | null;
}

async function isOwnerToken(c: ImageCtx, ownerId: string): Promise<boolean> {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length);
  if (!OwnerTokenSchema.safeParse(token).success) return false;

  const tokenHash = await sha256Hex(token);
  const owner = await c.env.DB.prepare("SELECT id FROM owners WHERE token_hash = ?").bind(tokenHash).first<{ id: string }>();
  return owner?.id === ownerId;
}

imageRoutes.get("/:id/:variant", burst("RL_READ"), async (c) => {
  const id = c.req.param("id");
  const variant = c.req.param("variant");
  if (variant !== "full" && variant !== "thumb") {
    return fail(c, "not_found", "Not found.", 404);
  }

  const photo = await c.env.DB.prepare(
    `SELECT p.id, p.owner_id, p.listing_id, p.r2_key_full, p.r2_key_thumb, p.content_type, l.status AS listing_status
     FROM photos p LEFT JOIN listings l ON l.id = p.listing_id
     WHERE p.id = ?`,
  )
    .bind(id)
    .first<PhotoRow>();

  if (!photo) return fail(c, "not_found", "Not found.", 404);

  const isPublic = photo.listing_status === "approved" || photo.listing_status === "given";
  if (!isPublic && !(await isOwnerToken(c, photo.owner_id))) {
    return fail(c, "not_found", "Not found.", 404);
  }

  // `CacheStorage.default` (the Workers-specific edge cache) isn't part of
  // the Cache API surface TypeScript's own lib types know about — only
  // Cloudflare's runtime types do, and `.default` isn't picked up through
  // the ambient global merge here. Read it through an index signature rather
  // than widen the whole `cache` binding to `any`.
  const cache = (caches as unknown as Record<"default", Cache>).default;
  const cacheKey = new Request(c.req.url);
  if (isPublic) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  const r2Key = variant === "full" ? photo.r2_key_full : photo.r2_key_thumb;
  const object = await c.env.BUCKET.get(r2Key);
  if (!object) return fail(c, "not_found", "Not found.", 404);

  const headers = new Headers();
  // The R2 object's own type, not the `photos` row's. There is one
  // `content_type` column and `PUT /api/photos` fills it from the **full**
  // variant's sniff only — so a photo whose two variants differ in format
  // (they are two independent client uploads; nothing derives one from the
  // other) served its thumb under the full's type. Browsers sniff, so this
  // was invisible, but the row is the wrong source of truth for a per-variant
  // header. Falls back to the column when the object carries no type, the
  // same shape `suggest/suggest.ts` already uses for the same reason.
  headers.set("Content-Type", object.httpMetadata?.contentType ?? photo.content_type);
  headers.set(
    "Cache-Control",
    // Owner-preview responses (unapproved listing, valid owner token) must
    // never be cached at the edge and handed back to a stranger who guesses
    // the same URL — only the public, approved/given path is cacheable at
    // all.
    //
    // Issue #22: this used to be `immutable, max-age=31536000` (one year).
    // That's the right choice for a URL whose *content* never changes, but
    // this one's *visibility* can: a listing can be withdrawn, hidden, or
    // deleted outright, and `caches.default.delete()` (see
    // `purgePhotoCache`, called from the delete paths) only ever reaches
    // Cloudflare's own edge cache. It cannot reach a stranger's browser
    // cache, a corporate proxy, or any other cache this response passed
    // through — every one of those is entitled by this header to keep
    // serving its own copy for as long as it says, with zero revalidation,
    // regardless of what happens server-side. A one-year promise on content
    // that can be pulled for someone's privacy is the wrong trade; one hour
    // bounds a real (if not instant) worst case instead of leaving it open
    // for a year. `immutable` is dropped for the same reason — it's a
    // promise that a *revalidation* would be wasted, which stops being true
    // the moment the listing is taken down.
    isPublic ? "public, max-age=3600" : "private, no-store",
  );

  const response = new Response(object.body, { headers });
  if (isPublic) {
    c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
});

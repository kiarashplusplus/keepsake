# Images

Status: `[DONE]` (M1), with two later additions folded in below: the terminal-listing photo
sweep (launch audit finding 15) and `burst("RL_READ")` on `/i/:id/:variant` (finding 9).

Every listing has 1–5 photos, each stored as two R2 objects (`photos/<id>/full.jpg` ≤2048px,
`photos/<id>/thumb.jpg` ≤640px) plus a D1 `photos` row carrying `width`, `height`, `blurhash`,
and `moderation_status`. The masonry grid uses the thumb; **the moderation vision model looks at
both**, one call each, because the two objects are two independent client uploads and neither is
derived from the other — moderating only the thumb meant `/i/:id/full` published bytes no model
had seen (#161, fixed 2026-09-07; see `docs/design/moderation.md` step 4 for the cost).

## Client-side pipeline (`apps/web/src/lib/images/`)

- Canvas resize to the 2048 (full) / 640 (thumb) fit-box, JPEG quality 0.85. The long-edge rule
  and validation constants (max dimensions, max bytes, allowed types) are ported from Finderly's
  `frontend/src/utils/ResizeImage.ts` and `imageValidation.ts` rather than re-derived.
- `blurhash` (4×3 components) computed from the thumb canvas client-side, so the server never
  needs an image-processing dependency just to get a placeholder.
- **Photo uploads are not idempotent, and nothing here claims they are.** The
  `X-Idempotency-Key` header on `POST /api/listings` comes from
  `apps/web/src/lib/hashIdempotencyKey.ts` (FNV-1a, ported from Finderly), sent by
  `give/review.tsx`; `PUT /api/photos` mounts no `idempotency()` and `uploadPhoto` sends no key.
  A sibling `images/uploadIdempotencyKey.ts` existed and said in its own docblock that it did,
  keyed on the source file's `name:size:lastModified` — it was called from nowhere on the client
  and read by nothing on the server, and five green unit tests guarded it (#181). Deleted
  2026-09-07 rather than wired up: that key cannot tell a retried upload apart from a giver
  deliberately adding the same photo twice, so wiring it would have handed two draft tiles the
  same `photo.id`. A duplicate orphan photo row is reaped by the orphan sweep within 24h; a
  duplicated id in a submitted listing is a live bug. If upload idempotency is wanted, key it on
  something per-attempt from the client and namespace the middleware's KV key by route first
  (`middleware/idempotency.ts`).

## Server-side

- `PUT /api/photos` (multipart: full, thumb, width, height, blurhash): magic-byte sniff for
  JPEG/PNG/WebP (never trust the declared content-type), `MAX_PHOTO_BYTES` backstop (5 MiB — the
  client already resizes under this, this is the check for a client that didn't), writes both R2
  objects, creates an orphan `photos` row (no `listing_id` yet).
- Orphan sweep (`17 3 * * *` cron): photos with `listing_id IS NULL` older than 24h get deleted
  from both R2 and D1 — abandoned `give` flows and upload-abuse probes both leave these behind,
  and per plan Risk #8, Turnstile moves onto the upload endpoint itself if abuse outpaces the
  sweep.
- Terminal-listing sweep (same nightly cron, added 2026-09-06 per launch audit finding 15):
  photos of listings that have been `rejected`, `withdrawn` or `hidden` for more than 30 days lose
  their R2 objects and their `photos` rows. The **listing** row stays — it is the audit trail for
  why the listing was pulled. `given` is excluded: those listings are still reachable at
  `/item/:id`, and a live page with a missing image is worse than one that keeps it. Thirty days is
  sized against the appeal path (`hidden` is reversible, `withdrawn` is re-listable), not against
  storage cost.
- `GET /i/:id/:variant?w=` serves through `caches.default`, immutable — R2 is the origin, the
  edge cache is what makes repeat views cheap. It is also rate-limited by `burst("RL_READ")` as of
  the launch audit (finding 9); before that the binding was declared in all three environments and
  called from nowhere. **`?w=` transforms are not implemented.** The `IMAGE_TRANSFORMS_ENABLED`
  var this paragraph used to describe was read by no code at all and was deleted from all three
  `wrangler.toml` blocks on 2026-09-06; originals are what `/i/:id/:variant` serves. Add the var
  back in the same commit that reads it.

## Why per-tier isolation matters

Finderly lost 122 images to a shared R2 bucket across environments. Keepsake's preview and
production each get their own `keepsake-photos-<env>` bucket (`wrangler.toml [env.*.r2_buckets]`)
— there is no code path that can touch the wrong environment's bucket, because there is no
shared bucket to touch.

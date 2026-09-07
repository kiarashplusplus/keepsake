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

- **One decode per photo.** `lib/images/prepareUpload.ts` is the whole pipeline: validate, decode
  once via `createImageBitmap`, then derive the full variant, the thumb and the blurhash from that
  single bitmap. It used to be four separate decodes of the same file (dimensions, full, thumb, and
  a fourth inside the blurhash encoder), two of them concurrent under a `Promise.all` — which is
  how you OOM a phone tab on a 48 MP photo.
- Canvas resize to the 2048 (full) / 640 (thumb) fit-box. JPEG quality 0.85 is the **first rung** of
  a four-step ladder (0.85/0.75/0.65/0.55) walked only when the encode overshoots the client's own
  output budget — `MAX_UPLOAD_BYTES` (4 MiB) and `MAX_THUMB_UPLOAD_BYTES` (400 KiB), both set below
  the server's ceiling so the giver gets a smaller file rather than an unactionable 413. An
  opaque white ground is painted before every draw: JPEG has no alpha, and a fresh canvas is
  transparent *black*, so a transparent PNG used to encode its transparency as black.
- **Shape is refused, not clamped.** `validateImageDimensions` (ported from Finderly's
  `frontend/src/utils/imageValidation.ts`, `projectedShortEdgePx` arithmetic included) rejects an
  image whose short edge cannot survive the fit — Finderly's issue #344. `fitBox`'s `Math.max(1, …)`
  clamp deliberately stays: a fit-box returning 0 would be wrong, and the guard belongs upstream of
  it. Finderly landed on the same split. The two failure modes get different words, because "too
  small" is untrue of a 20000×400 strip and "crop it" is untrue of a photo 1px under the floor.
- **The picker's MIME type is a hint, not a verdict.** `validateSourceFile` refuses only what is
  positively not an image; an empty or `application/octet-stream` type (Android pickers' "I don't
  know") falls through to the decode, which is the only thing that actually knows.
- `blurhash` (4×3 components) computed client-side from a 32px scratch canvas drawn off the same
  bitmap — 4×3 components cannot resolve more, and it removes a whole decode. A failed encode
  degrades to `FALLBACK_BLURHASH` rather than failing the upload: the placeholder shows for a few
  hundred milliseconds and is never worth losing a giver's photo over.
- **Everything is time-boxed and abortable.** `createImageBitmap` and `canvas.toBlob` have no
  timeout and are not cancellable, and `canContinue` is gated on `!isUploading` — so before this, a
  single hung decode disabled the Continue button for the entire give flow with no error text and
  no way out but a reload. Every step now runs under `withTimeout`, and every in-flight tile owns an
  `AbortController` that `handleRemove` and the unmount effect both fire.
- **HEIC.** Chrome, Firefox and Edge have never decoded HEIC and are not going to — it rides on
  HEVC, whose patent pools run into the 2030s, and every vendor invested in royalty-free AV1/AVIF
  instead. iOS is mostly self-solving (the system picker transcodes to JPEG *because* `accept`
  excludes HEIC — which is exactly why `pickImages.web.ts` must not add `image/heic` to it — and
  WebKit 17+ decodes HEIC anyway). The population left is desktop: a `.heic` pulled out of Finder,
  where nothing upstream converts it. `lib/images/heicFallback.ts` handles those with a
  dynamically-imported libheif/wasm decoder (`heic-to/csp`, the CSP-safe build). Measured against a
  real `expo export --platform web`: Metro emits it as a separate 2.9 MB chunk (737 KB gzipped) and
  the entry bundle grows by ~2.3 KB, so only the givers who actually pick a HEIC pay for it.
  **`expo-image-manipulator` cannot substitute for this on web** — its web implementation
  (`web/utils.web.ts`'s `loadImageAsync`) is an `<img>` element pointed at an object URL, so it
  inherits the browser's decoder and fails identically. On *native* it delegates to platform image
  APIs that decode HEIC fine, which is why the eventual native flip makes this module unnecessary
  on phones but never on desktop.
- **Drag-and-drop and paste** (`lib/images/useFileDrop.web.ts`, platform-split the same way
  `pickImages` is). The first thing this fixes isn't images: with no `drop` handler anywhere,
  dropping *any* file on the give flow made the browser navigate to it, and while the draft
  survives in `sessionStorage`, `deserializeGiveDraft` nulls every `objectUrl`, so the giver came
  back to a step whose tiles had lost their previews.
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

  The "Try again" button on a failed tile (added alongside the pipeline hardening) does **not**
  contradict this. It re-runs the pipeline from the source `File` the screen kept and mints a
  *fresh* `photo.id`, replacing the tile's — which is the "something per-attempt from the client"
  this paragraph asks for, and the opposite of a key that would dedupe two deliberate picks of the
  same file. It is offered only when the failure could plausibly go the other way (a timeout, a
  network drop, a 5xx); a refused format or shape would fail identically and gets no button.

## Server-side

- `PUT /api/photos` (multipart: full, thumb, width, height, blurhash): magic-byte sniff for
  JPEG/PNG/WebP (never trust the declared content-type), `MAX_PHOTO_BYTES` backstop (5 MiB — the
  client already resizes under this, this is the check for a client that didn't) plus a separate,
  much tighter `MAX_THUMB_BYTES` (768 KiB) with its own 413 message, so a caller cannot store a
  5 MiB "thumbnail" and a 413 says which half blew. Writes both R2 objects, creates an orphan
  `photos` row (no `listing_id` yet).
- **Dimensions come from the bytes, not the claim.** `sniffImageDimensions` reads width/height out
  of the JPEG SOF / PNG IHDR / WebP VP8 headers — pure byte arithmetic, which is the only kind
  available here (see below) — and those values are what get stored and returned. The multipart
  `width`/`height` fields are the fallback for a header this parser can't read; `null` is
  explicitly *not* a failure, or a parser gap would become a rejected upload. A shape the server
  *could* read and that is degenerate (short edge < 8px, or an aspect ratio past 64:1) is refused
  with a 400 — the backstop for any client that isn't ours.
- `GET /i/:id/:variant` serves each variant under **its own** stored content type
  (`object.httpMetadata.contentType`), not the `photos` row's single `content_type` column, which
  is filled from the full variant's sniff only. The two variants are independent client uploads, so
  nothing stops them differing in format.
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

## What the server can and cannot check (Workers)

`workerd` has no sharp, no libvips, no canvas and no `createImageBitmap`. Everything below is
therefore **impossible in this Worker**, and a future session should not plan around it:

- Server-side resize, re-encode, or normalisation (Finderly's `server/src/routes/media.ts` step 1,
  `sharp().rotate().resize({fit:'inside'}).jpeg()`), and with it server-side EXIF stripping.
- Any decoded-pixel limit. The server can bound *bytes*, never pixels-after-decode.
- Proving `full` and `thumb` are the same picture. #161 is fixed the only way Workers allows —
  by moderating both variants — not by rejecting mismatched ones.
- Converting a PNG/WebP thumb to JPEG before the vision call in `suggest/suggest.ts`.

What *is* enforceable is header parsing (`sniffImageType`, `sniffImageDimensions`) and byte caps,
which is what the two bullets above use. The Cloudflare Images binding (`env.IMAGES.info()` /
`.transform()`) is the only lever that would unlock the impossible list; it is a new binding in all
three `wrangler.toml` env blocks plus `.env.example`, and a per-request cost. Not added here.

Two recorded, un-actioned risks:

- The client re-encodes through a canvas, which carries no metadata, so EXIF/GPS is stripped for
  *our* client. A hostile client can still PUT EXIF-laden bytes that `/i/:id/full` serves back.
- `PUT /api/photos` accepts PNG and WebP from any client, and `suggest.ts` hands the stored bytes
  to the vision model as a data URI under their own content type. Only our web client produces
  uploads today and it always encodes JPEG, so this is unobserved; the lever if it ever bites is
  narrowing the accepted set, since conversion isn't available here.

## Why per-tier isolation matters

Finderly lost 122 images to a shared R2 bucket across environments. Keepsake's preview and
production each get their own `keepsake-photos-<env>` bucket (`wrangler.toml [env.*.r2_buckets]`)
— there is no code path that can touch the wrong environment's bucket, because there is no
shared bucket to touch.

/**
 * Client-side pre-flight checks on a picked photo, run before spending time
 * decoding/resizing/uploading it, plus the shape rules that decide whether a
 * decoded image can survive the pipeline at all.
 *
 * Two things changed here relative to the original M1 version, both ported
 * from Finderly's `frontend/src/utils/imageValidation.ts`:
 *
 *  1. **Shape is checked, not clamped.** Nothing used to look at an image's
 *     aspect ratio. `MIN_SOURCE_EDGE_PX` is a floor on the *source* short
 *     edge, so a 20000x400 strip passed it (400 >= 320) and then resized to
 *     2048x41 — a 640x13 thumb went to blurhash, to the moderation model and
 *     to the feed, where `clampCardAspectRatio` forced it into a 4:3 card as
 *     a wildly cropped sliver. This is Finderly's issue #344 in this
 *     codebase's own shape; `projectedShortEdgePx` below is their fix,
 *     arithmetic included.
 *
 *  2. **The picker's MIME type is a hint, not a verdict.** The old gate
 *     rejected anything outside `ALLOWED_IMAGE_TYPES`, which meant an
 *     Android picker reporting `""` or `application/octet-stream` — both of
 *     which mean "I don't know", not "not an image" — lost a perfectly good
 *     photo. `validateSourceFile` now rejects only what is *positively* not
 *     an image and lets everything else fall through to the decode, which is
 *     the only thing that actually knows. See Finderly's
 *     `validatePickedImageMetadata` for the same posture.
 *
 * The byte ceiling here is deliberately larger than the API's stored-bytes
 * ceiling (`MAX_PHOTO_BYTES`, 5 MiB) because this checks the raw camera
 * original *before* client-side resize brings it under that limit, not the
 * final uploaded size. `prepareUpload.ts` owns the output budget.
 */

export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
export const MIN_SOURCE_EDGE_PX = 320;

/**
 * Refuse a source with more decoded pixels than this. Bytes bound nothing
 * about pixel count — a 25 MB JPEG can decode to 200 megapixels — and five
 * of those in one give flow is how a mobile tab dies silently, taking the
 * whole draft with it.
 *
 * Be honest about what this buys: the check necessarily runs *after* the
 * decode that allocated the memory, so it cannot prevent the first crash.
 * What it does is turn the second photo's crash into a sentence the giver
 * can act on, and make the failure legible in analytics instead of
 * indistinguishable from a closed tab.
 */
export const MAX_SOURCE_PIXELS = 100_000_000;

export type ImageValidationError =
  // Source-level: knowable from the File alone.
  | "unsupported_type"
  | "too_large"
  // Shape-level: knowable once the pixel dimensions are in hand.
  | "too_small"
  | "aspect_degenerate"
  | "too_many_pixels"
  | "dimensions_unreadable"
  // Pipeline-level: something the browser wouldn't or couldn't do.
  | "heic_unsupported"
  | "decode_failed"
  | "encode_failed"
  | "timed_out";

export const IMAGE_VALIDATION_MESSAGES: Record<ImageValidationError, string> = {
  unsupported_type: "That file isn't a photo Keepsake can use. Try a JPEG, PNG, or WebP.",
  too_large: "That photo is too large. Try one under 25 MB.",
  too_small: "That photo is too small — at least 320px on the short side, please.",
  aspect_degenerate: "That photo is too long and thin to use. Crop it to the part you want to show.",
  too_many_pixels: "That photo has too many pixels for this browser to handle. Try one under 100 megapixels.",
  dimensions_unreadable: "Couldn't read that photo's size. Try another, or convert it to a JPEG.",
  // Deliberately says nothing about camera settings: the population that
  // actually reaches this is mostly desktop (a .heic dragged out of Finder or
  // exported from Photos), where "change how your camera saves photos" is
  // advice about a device the giver may not even be holding.
  heic_unsupported: "This browser can't open HEIC photos. Save it as a JPEG and try again.",
  decode_failed: "Couldn't read that photo. Try another.",
  encode_failed: "Couldn't prepare that photo for upload. Try another.",
  timed_out: "That photo took too long to process. Try again, or try a smaller one.",
};

/**
 * Shortest edge this image will have once fitted inside a `bound`-by-`bound`
 * box — i.e. what a long-edge fit leaves behind. Returns the untouched short
 * edge when the image already fits.
 *
 * `Math.round`, not `floor`, because that is what `fitBox` actually does. A
 * floor here would refuse images the pipeline would in fact have accepted.
 * Verbatim from Finderly, whose values were measured against a real sharp
 * pipeline (12000x900 -> 2048x154, 16000x8 -> 2048x1) rather than derived —
 * keeping the arithmetic identical means the two codebases agree.
 */
export function projectedShortEdgePx(width: number, height: number, bound: number): number {
  const longer = Math.max(width, height);
  const shorter = Math.min(width, height);
  if (longer <= bound) return shorter;
  return Math.round((shorter * bound) / longer);
}

/**
 * Whether a file claims to be HEIC/HEIF, by MIME or by extension. Used only
 * to pick the *message* after a decode has already failed — never to refuse
 * a file up front, since a browser that can decode HEIC (Safari 17+) should
 * be allowed to.
 */
export function looksLikeHeic(file: { type?: string; name?: string }): boolean {
  const type = (file.type ?? "").toLowerCase();
  if (type === "image/heic" || type === "image/heif") return true;
  const name = (file.name ?? "").toLowerCase();
  return name.endsWith(".heic") || name.endsWith(".heif");
}

/**
 * Checks what a `File`'s own metadata can settle: size, and a MIME type that
 * is positively not an image. Returns `null` when the file should proceed to
 * the decode — including when its type is empty or `application/octet-stream`
 * (the picker's "I don't know" sentinels) or a HEIC the browser may yet be
 * able to open.
 */
export function validateSourceFile(file: { type?: string; size: number }): ImageValidationError | null {
  if (file.size > MAX_SOURCE_BYTES) return "too_large";

  const type = (file.type ?? "").toLowerCase();
  // Empty and octet-stream both mean "unknown" — defer to the decode.
  if (type === "" || type === "application/octet-stream") return null;
  // Anything that names a non-image family is a verdict we can trust.
  if (!type.startsWith("image/")) return "unsupported_type";
  // An `image/*` subtype we can't rasterise is also a real verdict: SVG has
  // no pixels to analyse and `image/x-icon` is too small to be a keepsake.
  if (type === "image/svg+xml" || type === "image/x-icon" || type === "image/vnd.microsoft.icon") {
    return "unsupported_type";
  }
  // Every other image/* subtype — including HEIC — falls through to the
  // decode, which is the only thing that actually knows.
  return null;
}

/**
 * Checks decoded pixel dimensions against `bound`, the box this image will
 * be fitted inside downstream. Returns `null` when valid.
 *
 * Callers pass the *full* variant's edge (`FULL_EDGE_PX`), not the thumb's:
 * keepsake stores two variants, and the 640px thumb is a placeholder and a
 * moderation input, not the artefact. Holding the thumb to the same 320px
 * floor would refuse ordinary photos whose full variant is perfectly fine.
 */
export function validateImageDimensions(width: number, height: number, bound: number): ImageValidationError | null {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1
  ) {
    return "dimensions_unreadable";
  }

  if (width * height > MAX_SOURCE_PIXELS) return "too_many_pixels";

  if (projectedShortEdgePx(width, height, bound) >= MIN_SOURCE_EDGE_PX) return null;

  // The short edge won't clear the floor. Two different reasons, and they
  // need different words: the advice differs, and "too small" is simply
  // untrue of a 20000x400 strip.
  //
  // "Crop it" is only honest advice when the *fit* is what destroys the short
  // edge. An image already inside `bound` is never resized at all, so its
  // short edge is the one it was born with and cropping would only make it
  // worse — 2048x319 is not a long thin strip, it is a photo 1px under the
  // floor. So the degenerate branch requires both that the image will
  // actually be scaled down, and that its ratio is steep enough that no size
  // within the pipeline leaves it a usable short edge.
  const shorter = Math.min(width, height);
  const longer = Math.max(width, height);
  if (longer > bound && longer / shorter > bound / MIN_SOURCE_EDGE_PX) return "aspect_degenerate";
  return "too_small";
}

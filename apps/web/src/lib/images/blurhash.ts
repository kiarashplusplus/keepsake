/**
 * Encodes a blurhash placeholder, 4x3 components (the plan's chosen detail
 * level — enough to read as "a warm blob the right color" without being
 * expensive to compute or store).
 *
 * Two changes from the original: it encodes from the *decoded source bitmap*
 * rather than re-decoding the 640px thumb blob (that was a fourth decode of
 * the same photo, and `getImageData` on 640x480 allocates ~1.2 MB per photo
 * for detail 4x3 components cannot represent), and it has a non-throwing
 * wrapper, because a cosmetic placeholder must never be the reason a real
 * upload fails.
 */
import { encode } from "blurhash";

const COMPONENT_X = 4;
const COMPONENT_Y = 3;

/** Long edge of the scratch canvas the hash is computed from. 4x3 components
 * cannot resolve more than a handful of pixels per component, so anything
 * larger is pure cost. */
export const BLURHASH_SOURCE_EDGE_PX = 32;

/**
 * A neutral mid-grey 1x1-component hash, used when encoding fails. Generated
 * by running `encode` over a single rgb(128,128,128) pixel rather than
 * hand-written — the leading character encodes the component count, so a
 * plausible-looking literal is not a valid hash.
 *
 * `PublicPhoto`'s `blurhash` is `z.string().min(6)`, and a 1x1 hash is
 * exactly six characters — the shortest valid blurhash there is, which is
 * why this constant is the natural fallback rather than an arbitrary string.
 * `blurhash.test.ts` pins both facts by decoding it.
 *
 * Lives here rather than in `@keepsake/contracts`: the server never produces
 * a blurhash, so exporting it there would be a shared constant with one
 * user — the trap `contracts/src/photo.ts` documents at length.
 */
export const FALLBACK_BLURHASH = "00Eyb[";

/** Encodes from an already-decoded bitmap. Throws on a missing 2D context or
 * an `encode` failure — callers that can't afford either want
 * `safeEncodeBlurhash`. */
export function encodeBlurhashFromBitmap(bitmap: ImageBitmap): string {
  const longEdge = Math.max(bitmap.width, bitmap.height);
  const scale = longEdge > BLURHASH_SOURCE_EDGE_PX ? BLURHASH_SOURCE_EDGE_PX / longEdge : 1;
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.drawImage(bitmap, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  return encode(imageData.data, imageData.width, imageData.height, COMPONENT_X, COMPONENT_Y);
}

/**
 * `encodeBlurhashFromBitmap`, degrading to `FALLBACK_BLURHASH` instead of
 * throwing. The placeholder is what shows for a few hundred milliseconds
 * before the real image paints; losing the giver's upload over it — which is
 * what happened before, since the encode was awaited inside the upload's own
 * `try` and surfaced as "That upload didn't go through." — is a bad trade at
 * any failure rate.
 */
export function safeEncodeBlurhash(bitmap: ImageBitmap): string {
  try {
    return encodeBlurhashFromBitmap(bitmap);
  } catch {
    return FALLBACK_BLURHASH;
  }
}

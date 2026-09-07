/**
 * The whole client-side photo pipeline in one place, with no React in it:
 * source file in, two encoded variants plus a blurhash out.
 *
 * The shape of this module is the point. It used to be four separate
 * `createImageBitmap` calls on the same file — `readImageDimensions`, one
 * resize for `full`, another for `thumb`, and a fourth inside
 * `encodeBlurhashFromBlob` — spread across `app/give/index.tsx`, two of them
 * running concurrently under a `Promise.all` that sat directly beneath a
 * comment explaining that concurrent full-size decodes are how you OOM a
 * phone. Now there is exactly one decode, and everything else is derived
 * from that one bitmap.
 *
 * Every step is time-boxed and abortable. Nothing here throws a bare
 * `Error`: every failure is an `ImagePrepError` carrying a machine code, so
 * the give flow can pick its copy and decide retryability without matching
 * on strings.
 */
import { FULL_EDGE_PX, THUMB_EDGE_PX } from "@keepsake/contracts/photo";
import { safeEncodeBlurhash } from "@/lib/images/blurhash";
import { convertHeicToJpeg } from "@/lib/images/heicFallback";
import { ImagePrepError, decodeImage, drawToJpeg, fitBox, type FitBox, type ResizedImage } from "@/lib/images/resizeImage";
import { MAX_SOURCE_PIXELS, looksLikeHeic, validateImageDimensions, validateSourceFile } from "@/lib/images/validateImage";

/**
 * The client's own output budget for the `full` variant, set *below* the
 * server's `MAX_PHOTO_BYTES` (5 MiB) so the quality ladder has somewhere to
 * land before the server's 413 — which is copy a giver cannot act on, since
 * nothing they can see explains it.
 *
 * Deliberately not imported from `@keepsake/contracts`: this is the client's
 * budget, not the server's limit, and the two are different numbers for a
 * reason. Making them one shared constant would be the exact trap
 * `contracts/src/photo.ts` documents.
 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/** The thumb is a 640px placeholder; anything approaching the full variant's
 * budget means something has gone wrong with the encode. */
export const MAX_THUMB_UPLOAD_BYTES = 400 * 1024;

export type PreparedUpload = {
  full: ResizedImage;
  thumb: ResizedImage;
  blurhash: string;
  /** Post-EXIF-rotation source dimensions, for analytics and debugging — the
   * dimensions actually uploaded are `full.width`/`full.height`. */
  sourceWidth: number;
  sourceHeight: number;
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Maps a rejected decode onto the most specific code we can justify. A
 * browser that cannot decode a file *is* the format check — Finderly's
 * `imageResize.ts` reaches the same conclusion for the same reason: there is
 * no cheaper oracle, and guessing from the extension alone is how a
 * perfectly good photo gets refused. */
function decodeFailureCode(file: File, error: unknown): ImagePrepError {
  if (isTimeout(error)) return new ImagePrepError("timed_out");
  return new ImagePrepError(looksLikeHeic(file) ? "heic_unsupported" : "decode_failed");
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.message.includes("timed out");
}

/** Runs one encode, normalising anything `withTimeout` or the canvas throws
 * into an `ImagePrepError`. Without this a timed-out encode would escape as a
 * bare `Error` and the give flow would show its raw message. */
async function encodeVariant(
  bitmap: ImageBitmap,
  box: FitBox,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<ResizedImage> {
  try {
    return await drawToJpeg(bitmap, box, { maxBytes, ...(signal !== undefined ? { signal } : {}) });
  } catch (error) {
    if (isAbortError(error) || error instanceof ImagePrepError) throw error;
    throw new ImagePrepError(isTimeout(error) ? "timed_out" : "encode_failed");
  }
}

/**
 * Validates, decodes once, and produces both variants plus a blurhash.
 *
 * Ordered cheapest-check-first, so a photo that cannot succeed is refused
 * before it costs a decode, and a shape that cannot survive the pipeline is
 * refused before it costs an encode.
 */
export async function prepareUpload(file: File, options: { signal?: AbortSignal } = {}): Promise<PreparedUpload> {
  const { signal } = options;

  const sourceError = validateSourceFile(file);
  if (sourceError !== null) throw new ImagePrepError(sourceError);

  let bitmap: ImageBitmap;
  try {
    bitmap = await decodeImage(file, signal !== undefined ? { signal } : {});
  } catch (error) {
    if (isAbortError(error)) throw error;
    // A browser that can decode HEIC (Safari 17+) never reaches here. One
    // that can't gets the wasm decoder, fetched on demand — see
    // `heicFallback.ts` for why this can't be the browser's job or Expo's.
    if (!isTimeout(error) && looksLikeHeic(file)) {
      // Statically imported, but the module is a few hundred bytes: the ~2.9 MB
      // decoder behind it is what's dynamically imported, inside that module.
      // Keeping the `import()` there rather than here also means this file
      // stays testable under Jest, which does not transpile native dynamic
      // import in jsdom.
      const converted = await convertHeicToJpeg(file);
      bitmap = await decodeImage(converted, signal !== undefined ? { signal } : {});
    } else {
      throw decodeFailureCode(file, error);
    }
  }

  try {
    // Read the real dimensions off the bitmap rather than trusting anything
    // the picker said. This is also the only place the pixel count is
    // knowable — see MAX_SOURCE_PIXELS on why the check lives after the
    // allocation it describes.
    const { width, height } = bitmap;
    if (width * height > MAX_SOURCE_PIXELS) throw new ImagePrepError("too_many_pixels");

    const shapeError = validateImageDimensions(width, height, FULL_EDGE_PX);
    if (shapeError !== null) throw new ImagePrepError(shapeError);

    const full = await encodeVariant(bitmap, fitBox(width, height, FULL_EDGE_PX), MAX_UPLOAD_BYTES, signal);
    // From the same bitmap, not from `full.blob`: resampling the source once
    // is both cheaper and better-looking than resampling an already-lossy
    // 2048px JPEG.
    const thumb = await encodeVariant(bitmap, fitBox(width, height, THUMB_EDGE_PX), MAX_THUMB_UPLOAD_BYTES, signal);

    return { full, thumb, blurhash: safeEncodeBlurhash(bitmap), sourceWidth: width, sourceHeight: height };
  } finally {
    bitmap.close();
  }
}

/**
 * Decode and re-encode primitives for the upload pipeline. `prepareUpload.ts`
 * composes them; nothing else should call them directly.
 *
 * `createImageBitmap` with `imageOrientation: "from-image"` bakes in EXIF
 * rotation before we ever touch a canvas, so the output is right-side-up
 * without us parsing EXIF ourselves. One caveat worth knowing rather than
 * fixing here: Safari ignored `createImageBitmap`'s options bag until 17, so
 * on older WebKit both that orientation guarantee and the `resizeWidth` hint
 * below are best-effort, not contractual.
 */
import { withTimeout } from "@/lib/images/withTimeout";
import { IMAGE_VALIDATION_MESSAGES, type ImageValidationError } from "@/lib/images/validateImage";

/** Carries a stable machine code so the give flow can pick copy *and* decide
 * whether a retry could plausibly succeed, rather than parsing a message. */
export class ImagePrepError extends Error {
  readonly code: ImageValidationError;

  constructor(code: ImageValidationError) {
    super(IMAGE_VALIDATION_MESSAGES[code]);
    this.name = "ImagePrepError";
    this.code = code;
  }
}

export type FitBox = { width: number; height: number };

/**
 * Long-edge fit: scales `width`x`height` down (never up) so the longer edge
 * is at most `maxEdge`, preserving aspect ratio. Pure and synchronous so it
 * can be unit-tested without a DOM.
 *
 * **The `Math.max(1, ...)` clamp stays on purpose — do not "fix" it.** A
 * fit-box that returned 0 would be wrong, and a canvas sized 0 is a decode
 * error rather than a useful refusal. The degenerate-shape bug was never
 * here: it was that nothing refused an extreme aspect ratio *before* calling
 * this. `validateImageDimensions` is that check, and `prepareUpload` runs it
 * first. Finderly landed on exactly this split — the identical clamp survives
 * in their `planResize`, with the guard upstream in `canvasResizeToBase64`.
 */
export function fitBox(width: number, height: number, maxEdge: number): FitBox {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge) {
    return { width, height };
  }
  const scale = maxEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export type ResizedImage = {
  blob: Blob;
  width: number;
  height: number;
};

export const DECODE_TIMEOUT_MS = 15_000;
export const ENCODE_TIMEOUT_MS = 10_000;

/**
 * Quality rungs tried in order until the encoded blob fits its byte budget.
 * 0.85 is the long-standing default and stays the first rung, so an ordinary
 * photo encodes exactly as it always did and never pays for a second pass.
 */
export const JPEG_QUALITY_LADDER = [0.85, 0.75, 0.65, 0.55] as const;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new DOMException("Aborted", "AbortError");
}

/**
 * Decodes `source` once, time-boxed.
 *
 * There is no downsample-during-decode hint here, and that is deliberate.
 * `createImageBitmap`'s `resizeWidth`/`resizeHeight` resize to *exactly* those
 * dimensions when both are given — it is not a fit-box, so passing the same
 * number for each stretches a non-square photo — and passing only one of them
 * requires knowing the orientation, which is not knowable until after the
 * decode we would be trying to bound. Reading the true dimensions off the
 * bitmap and refusing past `MAX_SOURCE_PIXELS` is the honest version of the
 * same protection: it cannot prevent the first allocation, but it is correct,
 * whereas a hint that silently distorts every portrait photo is not.
 */
export async function decodeImage(
  source: Blob,
  options: { signal?: AbortSignal } = {},
): Promise<ImageBitmap> {
  throwIfAborted(options.signal);
  return withTimeout(
    createImageBitmap(source, { imageOrientation: "from-image" }),
    DECODE_TIMEOUT_MS,
    "decodeImage",
  );
}

/**
 * Given the size the last rung produced, the index of the next rung to try —
 * or `null` when the blob already fits or the ladder is exhausted. Pure, so
 * the step-down policy is testable without a canvas.
 */
export function nextQualityIndex(currentIndex: number, bytes: number, maxBytes: number | undefined): number | null {
  if (maxBytes === undefined || bytes <= maxBytes) return null;
  const next = currentIndex + 1;
  return next < JPEG_QUALITY_LADDER.length ? next : null;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new ImagePrepError("encode_failed"));
      },
      type,
      quality,
    );
  });
}

/**
 * Draws `bitmap` into a `box`-sized canvas and encodes it as JPEG, stepping
 * down `JPEG_QUALITY_LADDER` until the result fits `maxBytes` (or the ladder
 * runs out, in which case the smallest attempt is returned — the server's own
 * ceiling is the backstop, and a slightly-too-big upload that gets a real 413
 * beats refusing a photo we might have been able to send).
 */
export async function drawToJpeg(
  bitmap: ImageBitmap,
  box: FitBox,
  options: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<ResizedImage> {
  throwIfAborted(options.signal);

  const canvas = document.createElement("canvas");
  canvas.width = box.width;
  canvas.height = box.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new ImagePrepError("encode_failed");

  // JPEG has no alpha channel, and a fresh canvas is transparent *black* —
  // so without this, every transparent pixel of a PNG encodes as black.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, box.width, box.height);
  ctx.drawImage(bitmap, 0, 0, box.width, box.height);

  let index = 0;
  let blob: Blob | undefined;
  for (;;) {
    throwIfAborted(options.signal);
    const quality = JPEG_QUALITY_LADDER[index] ?? JPEG_QUALITY_LADDER[JPEG_QUALITY_LADDER.length - 1] ?? 0.85;
    blob = await withTimeout(canvasToBlob(canvas, "image/jpeg", quality), ENCODE_TIMEOUT_MS, "drawToJpeg");
    const next = nextQualityIndex(index, blob.size, options.maxBytes);
    if (next === null) break;
    index = next;
  }

  return { blob, width: box.width, height: box.height };
}

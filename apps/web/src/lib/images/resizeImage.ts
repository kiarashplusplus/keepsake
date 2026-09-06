/**
 * Client-side resize to the two stored sizes (full/thumb — see
 * `@keepsake/contracts/photo`'s `FULL_EDGE_PX`/`THUMB_EDGE_PX`), so uploads
 * never ship a multi-megabyte camera original. `createImageBitmap` with
 * `imageOrientation: "from-image"` bakes in EXIF rotation before we ever
 * touch a canvas, so the output is always right-side-up without us parsing
 * EXIF ourselves.
 */

export type FitBox = { width: number; height: number };

/**
 * Long-edge fit: scales `width`x`height` down (never up) so the longer edge
 * is at most `maxEdge`, preserving aspect ratio. Pure and synchronous so it
 * can be unit-tested without a DOM.
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

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Canvas toBlob failed"));
      },
      type,
      quality,
    );
  });
}

const JPEG_QUALITY = 0.85;

/** Decodes `source`, fits it to `maxEdge` on the long edge, and re-encodes
 * as JPEG at quality 0.85. */
export async function resizeImage(source: Blob, maxEdge: number): Promise<ResizedImage> {
  const bitmap = await createImageBitmap(source, { imageOrientation: "from-image" });
  try {
    const { width, height } = fitBox(bitmap.width, bitmap.height, maxEdge);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvasToBlob(canvas, "image/jpeg", JPEG_QUALITY);
    return { blob, width, height };
  } finally {
    bitmap.close();
  }
}

/** Reads just the pixel dimensions of `source` without resizing — used to
 * validate the minimum edge before doing any resize work. */
export async function readImageDimensions(source: Blob): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(source, { imageOrientation: "from-image" });
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

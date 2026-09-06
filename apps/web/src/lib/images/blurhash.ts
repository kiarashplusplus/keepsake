/**
 * Encodes a blurhash placeholder from the thumb image, 4x3 components (the
 * plan's chosen detail level — enough to read as "a warm blob the right
 * color" without being expensive to compute or store).
 */
import { encode } from "blurhash";

const COMPONENT_X = 4;
const COMPONENT_Y = 3;

export async function encodeBlurhashFromBlob(thumb: Blob): Promise<string> {
  const bitmap = await createImageBitmap(thumb);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return encode(imageData.data, imageData.width, imageData.height, COMPONENT_X, COMPONENT_Y);
  } finally {
    bitmap.close();
  }
}

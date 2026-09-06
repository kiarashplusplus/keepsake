/**
 * Client-side pre-flight checks on a picked photo, run before spending time
 * resizing/uploading it. MIME allowlist mirrors
 * `@keepsake/contracts/photo`'s `ALLOWED_IMAGE_TYPES`; the byte ceiling here
 * is deliberately larger than the API's stored-bytes ceiling
 * (`MAX_PHOTO_BYTES`, 5 MB) because this checks the raw camera original
 * *before* client-side resize brings it under that limit, not the final
 * uploaded size.
 */
import { ALLOWED_IMAGE_TYPES, type AllowedImageType } from "@keepsake/contracts/photo";

export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
export const MIN_SOURCE_EDGE_PX = 320;

export type ImageValidationError = "unsupported_type" | "too_large" | "too_small";

export const IMAGE_VALIDATION_MESSAGES: Record<ImageValidationError, string> = {
  unsupported_type: "That file isn't a photo Keepsake can use. Try a JPEG, PNG, or WebP.",
  too_large: "That photo is too large. Try one under 25 MB.",
  too_small: "That photo is too small — at least 320px on the short side, please.",
};

function isAllowedType(type: string): type is AllowedImageType {
  return (ALLOWED_IMAGE_TYPES as readonly string[]).includes(type);
}

/** Checks MIME type and file size. Returns `null` when valid. */
export function validateImageFile(file: { type: string; size: number }): ImageValidationError | null {
  if (!isAllowedType(file.type)) return "unsupported_type";
  if (file.size > MAX_SOURCE_BYTES) return "too_large";
  return null;
}

/** Checks decoded pixel dimensions. Returns `null` when valid. */
export function validateImageDimensions(width: number, height: number): ImageValidationError | null {
  if (Math.min(width, height) < MIN_SOURCE_EDGE_PX) return "too_small";
  return null;
}

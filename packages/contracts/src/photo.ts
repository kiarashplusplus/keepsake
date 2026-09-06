import { z } from "zod";
import { UlidSchema } from "./common";

export const MAX_PHOTOS = 5;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const AllowedImageTypeSchema = z.enum(ALLOWED_IMAGE_TYPES);
export type AllowedImageType = z.infer<typeof AllowedImageTypeSchema>;

/** Long edge, in px, that uploads are resized to before storage. */
export const FULL_EDGE_PX = 2048;
export const THUMB_EDGE_PX = 640;

export const ImageUrlSchema = z
  .string()
  .min(1)
  .refine((v) => v.startsWith("/i/") || /^https?:\/\//.test(v), "Expected /i/... or an absolute http(s) URL");

export const PublicPhoto = z.object({
  id: UlidSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  blurhash: z.string().min(6).max(100),
  // Origin-relative (`/i/<id>/full`) from the API, absolute once a client has
  // resolved it against its origin. Both are valid; a bare `.url()` rejected
  // every real response.
  url_full: ImageUrlSchema,
  url_thumb: ImageUrlSchema,
});
export type PublicPhoto = z.infer<typeof PublicPhoto>;

/** Multipart fields alongside the binary body on `PUT /api/photos`. */
export const UploadPhotoFields = z.object({
  width: z.number().int().min(1).max(8192),
  height: z.number().int().min(1).max(8192),
  blurhash: z.string().min(6).max(100),
});
export type UploadPhotoFields = z.infer<typeof UploadPhotoFields>;

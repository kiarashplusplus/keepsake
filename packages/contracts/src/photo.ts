import { z } from "zod";
import { UlidSchema } from "./common";
import { CategorySchema, TITLE_MAX, TITLE_MIN } from "./category";

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

/**
 * `POST /api/photos/:id/suggest`'s successful shape — the vision model's
 * read of a photo's cover, turned into give-flow form fields. Constrained to
 * the *real* `CategorySchema`/title bounds (imported from `./category`, not
 * duplicated) so a bad or hallucinated suggestion can never produce a form
 * the giver isn't allowed to submit: an out-of-enum category or an
 * over-length title fails `safeParse` in `src/suggest/suggest.ts` rather
 * than reaching the client. Every field is trimmed since the model is asked
 * for prose, not machine-formatted input.
 */
export const PhotoSuggestionSchema = z.object({
  /** What the model says is literally in the frame — not shown in the form,
   * kept so a caller can log/debug why a suggestion looked the way it did. */
  subject: z.string().trim().max(120),
  /** A short, warm, specific name for the object — pre-fills the listing
   * title, so it must satisfy the same bounds `CreateListingInput` enforces. */
  title: z.string().trim().min(TITLE_MIN).max(TITLE_MAX),
  category: CategorySchema,
  /** Visible wear/material/age cues, one short clause. Empty string when
   * nothing is notable — never stored on the listing (see Part 3 of the give
   * flow plan); spent only as a dismissible opener on the story step. */
  condition: z.string().trim().max(160),
  /**
   * eBay-style structured attributes read off the photo — `object`,
   * `material`, `era`, `colour`, `maker`, `pattern` are the suggested
   * vocabulary but not an enum; the model may use another short lowercase
   * name if it fits better. Forward-looking: `category` is slated to be
   * dropped in a later change in favor of these, and emitting them now
   * avoids a second vision call once that change lands.
   *
   * Capped at 6 and defaulted to `[]` rather than required, because the
   * right number of visible aspects for a given photo is often zero — the
   * prompt tells the model to omit an aspect it isn't sure of rather than
   * guess, since a wrong-but-confident aspect is worse than a missing one
   * (it can silently hide the listing from someone filtering by it, which
   * is eBay's own documented failure mode for this exact feature).
   */
  aspects: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(24),
        value: z.string().trim().min(1).max(48),
      }),
    )
    .max(6)
    .default([]),
});
export type PhotoSuggestion = z.infer<typeof PhotoSuggestionSchema>;

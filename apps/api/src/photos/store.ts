/**
 * Validating and storing an uploaded photo — the one implementation, shared
 * by `PUT /api/photos` (the give flow) and the estate bulk-upload route.
 *
 * Extracted from `routes/photos.ts` unchanged in behaviour. Every rule below
 * was already there and every comment moved with the code it explains; what
 * is new is only the two optional parameters at the bottom of
 * `StorePhotoOptions`, neither of which the single-item path passes.
 *
 * It returns a discriminated union rather than a `Response`, so each router
 * maps a refusal through its own `fail(...)`. A shared function that returned
 * a `Response` would be a shared function that decides another router's error
 * shape.
 */
import { UploadPhotoFields } from "@keepsake/contracts/photo";
import type { ErrorCode } from "@keepsake/contracts/common";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Env } from "../env.js";
import { parseIntVar } from "../env.js";
import { ulid } from "../lib/ids.js";
import { extensionForSniffedType, sniffImageDimensions, sniffImageType } from "../lib/imageSniff.js";

export const DEFAULT_MAX_PHOTO_BYTES = 5 * 1024 * 1024;
/**
 * The `thumb` variant gets its own, much tighter ceiling. Both variants used
 * to share `MAX_PHOTO_BYTES`, which meant a caller could PUT a 5 MiB
 * "thumbnail" — stored, served from `/i/:id/thumb`, and base64'd into a
 * vision-model prompt by `suggest/suggest.ts`. A real 640px thumb from our
 * own client is tens of kilobytes; 768 KiB is loose enough that no honest
 * encode can hit it and tight enough that the abuse case can't.
 */
export const DEFAULT_MAX_THUMB_BYTES = 768 * 1024;

/**
 * Server-side backstop for the degenerate-aspect refusal the web client now
 * makes in `lib/images/validateImage.ts`. This route is reachable with an
 * owner token and nothing else (see the Turnstile note in `routes/photos.ts`),
 * so a client that isn't ours can still present a 16000x8 strip — which
 * renders in the feed as a wildly cropped sliver and gives the moderation
 * model a few dozen pixels of height to judge.
 *
 * Only applied when the dimensions were actually read off the bytes: a
 * declared aspect ratio is a claim, and refusing an upload on a claim we
 * can't verify would be worse than storing it.
 */
export const MAX_STORED_ASPECT_RATIO = 64;
export const MIN_STORED_EDGE_PX = 8;

export interface StoredPhoto {
  id: string;
  width: number;
  height: number;
  blurhash: string;
  url_full: string;
  url_thumb: string;
}

export type StorePhotoResult =
  | { ok: true; photo: StoredPhoto }
  | {
      ok: false;
      code: ErrorCode;
      message: string;
      status: ContentfulStatusCode;
      /** Flattened zod issues, present only on the metadata-validation
       * refusal — preserved so `PUT /api/photos` answers exactly as it did
       * before this extraction. */
      issues?: Record<string, unknown>;
    };

export interface StorePhotoOptions {
  ownerId: string;
  /** The multipart body, already parsed by the caller — the two routers
   * differ in how they answer a body that will not parse at all. */
  form: FormData;
  /**
   * Pre-chosen id. The bulk route fixes this per `(batch_id, client_photo_id)`
   * so retries target the same row and the same deterministic R2 keys.
   */
  photoId?: string;
  /**
   * Protects the row from `cron/orphanSweep.ts`, which deletes any photo with
   * `listing_id IS NULL` older than 24 hours. A batch is prepared over days
   * and every photo in it is unattached until submission, so without this a
   * giver's second evening would find the first evening's work gone.
   */
  retainUntil?: number;
}

export async function storePhotoUpload(env: Env, options: StorePhotoOptions): Promise<StorePhotoResult> {
  const { form, ownerId } = options;

  const full = form.get("full");
  const thumb = form.get("thumb");
  if (!(full instanceof File) || !(thumb instanceof File)) {
    return { ok: false, code: "bad_request", message: "Both `full` and `thumb` files are required.", status: 400 };
  }

  const fieldsResult = UploadPhotoFields.safeParse({
    width: Number(form.get("width")),
    height: Number(form.get("height")),
    blurhash: form.get("blurhash"),
  });
  if (!fieldsResult.success) {
    return {
      ok: false,
      code: "bad_request",
      message: "Invalid photo metadata.",
      status: 400,
      issues: fieldsResult.error.flatten() as unknown as Record<string, unknown>,
    };
  }
  const { width, height, blurhash } = fieldsResult.data;

  const maxBytes = parseIntVar("MAX_PHOTO_BYTES", env.MAX_PHOTO_BYTES, DEFAULT_MAX_PHOTO_BYTES);
  const maxThumbBytes = parseIntVar("MAX_THUMB_BYTES", env.MAX_THUMB_BYTES, DEFAULT_MAX_THUMB_BYTES);

  const fullBytes = new Uint8Array(await full.arrayBuffer());
  const thumbBytes = new Uint8Array(await thumb.arrayBuffer());

  if (fullBytes.byteLength > maxBytes) {
    return { ok: false, code: "payload_too_large", message: "Photo exceeds the maximum upload size.", status: 413 };
  }
  // Its own message, so a 413 says which half blew rather than sending the
  // caller to check the wrong number.
  if (thumbBytes.byteLength > maxThumbBytes) {
    return {
      ok: false,
      code: "payload_too_large",
      message: "Photo thumbnail exceeds the maximum upload size.",
      status: 413,
    };
  }

  // Never trust the multipart part's declared content-type — sniff the actual
  // bytes. See docs/design/images.md.
  const fullType = sniffImageType(fullBytes);
  const thumbType = sniffImageType(thumbBytes);
  if (!fullType || !thumbType) {
    return { ok: false, code: "unsupported_media", message: "Photos must be JPEG, PNG, or WebP.", status: 415 };
  }

  // The client's declared width/height are a hint; the bytes we are about to
  // store are the authority. These numbers drive the masonry layout and the
  // public `PublicPhoto`, and nothing before this made a caller's claim agree
  // with what it actually sent.
  //
  // `null` (a header this parser can't read) is not a failure — it falls back
  // to the declared values, exactly as this route behaved before.
  const sniffedDims = sniffImageDimensions(fullBytes);
  const storedWidth = sniffedDims?.width ?? width;
  const storedHeight = sniffedDims?.height ?? height;

  if (sniffedDims) {
    const shorter = Math.min(sniffedDims.width, sniffedDims.height);
    const longer = Math.max(sniffedDims.width, sniffedDims.height);
    if (shorter < MIN_STORED_EDGE_PX || longer / shorter > MAX_STORED_ASPECT_RATIO) {
      return { ok: false, code: "bad_request", message: "That photo is too long and thin to use.", status: 400 };
    }
  }

  const id = options.photoId ?? ulid();
  const fullKey = `photos/${id}/full.${extensionForSniffedType(fullType)}`;
  const thumbKey = `photos/${id}/thumb.${extensionForSniffedType(thumbType)}`;

  await env.BUCKET.put(fullKey, fullBytes, { httpMetadata: { contentType: fullType } });
  await env.BUCKET.put(thumbKey, thumbBytes, { httpMetadata: { contentType: thumbType } });

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO photos
      (id, owner_id, listing_id, position, r2_key_full, r2_key_thumb, width, height, bytes_full, blurhash, content_type, moderation_status, created_at, retain_until)
     VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 'unchecked', ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       r2_key_full = excluded.r2_key_full,
       r2_key_thumb = excluded.r2_key_thumb,
       width = excluded.width,
       height = excluded.height,
       bytes_full = excluded.bytes_full,
       blurhash = excluded.blurhash,
       content_type = excluded.content_type,
       moderation_status = excluded.moderation_status,
       retain_until = excluded.retain_until`,
  )
    .bind(
      id,
      ownerId,
      fullKey,
      thumbKey,
      storedWidth,
      storedHeight,
      fullBytes.byteLength,
      blurhash,
      fullType,
      now,
      options.retainUntil ?? null,
    )
    .run();

  return {
    ok: true,
    photo: {
      id,
      width: storedWidth,
      height: storedHeight,
      blurhash,
      url_full: `/i/${id}/full`,
      url_thumb: `/i/${id}/thumb`,
    },
  };
}

export interface DeletablePhotoRow {
  id: string;
  r2_key_full: string;
  r2_key_thumb: string;
}

/** Deletes a photo's bytes and its row. The caller has already proved
 * ownership and that the listing is not `given`. */
export async function deletePhotoAndObjects(env: Env, photo: DeletablePhotoRow): Promise<void> {
  await env.BUCKET.delete(photo.r2_key_full);
  await env.BUCKET.delete(photo.r2_key_thumb);
  await env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(photo.id).run();
}

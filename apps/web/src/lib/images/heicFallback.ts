/**
 * Last-resort HEIC decode, loaded only when one is actually needed.
 *
 * Chrome, Firefox and Edge have never shipped a HEIC decoder and are not
 * going to: HEIC rides on HEVC, whose patent pools run into the 2030s, and
 * every vendor put its effort into the royalty-free AV1/AVIF stack instead.
 * So "wait for browsers to fix it" is not a plan, and a photo that arrives as
 * HEIC on desktop Chrome is a photo we either convert ourselves or refuse.
 *
 * `expo-image-manipulator` cannot help here even though this is an Expo app:
 * its web implementation (`web/utils.web.ts`'s `loadImageAsync`) is an
 * `<img>` element pointed at an object URL, so it inherits the browser's
 * decoder exactly as `createImageBitmap` does and fails identically. On
 * *native* it delegates to platform image APIs that decode HEIC fine — which
 * is why this module is web-only and why the eventual native flip
 * (`pickImages.ts`) makes it unnecessary on phones.
 *
 * The import is dynamic on purpose: the decoder is ~2.9 MB (~0.7 MB over the
 * wire) and the overwhelming majority of givers never touch it, so it must
 * not be in the bundle everyone downloads.
 */
import { ImagePrepError } from "@/lib/images/resizeImage";

/** Long edge the converted JPEG is capped at. The pipeline resizes again
 * afterwards; this only bounds what the decoder hands back. */
const CONVERT_QUALITY = 0.92;

export async function convertHeicToJpeg(file: File): Promise<Blob> {
  let heicTo: (options: { blob: Blob; type: string; quality: number }) => Promise<Blob>;
  try {
    // `heic-to/csp` rather than the default entry: the CSP-safe build avoids
    // `unsafe-eval`, which this site's Content-Security-Policy does not grant.
    ({ heicTo } = await import("heic-to/csp"));
  } catch {
    // Chunk fetch failed (offline, cache miss on a stale deploy). Not the
    // giver's fault and not something a retry of the *pipeline* fixes, so
    // report it as the HEIC problem it is.
    throw new ImagePrepError("heic_unsupported");
  }

  try {
    return await heicTo({ blob: file, type: "image/jpeg", quality: CONVERT_QUALITY });
  } catch {
    throw new ImagePrepError("heic_unsupported");
  }
}

/**
 * Magic-byte sniffing for the three upload types this app accepts. Never
 * trust a multipart part's declared content-type — it's client-supplied and
 * a hostile or broken client can put anything there — so `PUT /api/photos`
 * always checks the bytes it actually received.
 */
export const ALLOWED_SNIFFED_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type SniffedImageType = (typeof ALLOWED_SNIFFED_TYPES)[number];

export function sniffImageType(bytes: Uint8Array): SniffedImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }

  // RIFF....WEBP: "RIFF" at 0-3, 4 bytes of chunk size, "WEBP" at 8-11.
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  return null;
}

export function extensionForSniffedType(type: SniffedImageType): "jpg" | "png" | "webp" {
  if (type === "image/jpeg") return "jpg";
  if (type === "image/png") return "png";
  return "webp";
}

/**
 * Reads pixel dimensions out of an image's header bytes.
 *
 * Pure byte arithmetic, which is the whole reason it can exist: `workerd`
 * has no sharp, no libvips and no canvas, so decoding is off the table — but
 * every format we accept writes its dimensions in the clear near the front
 * of the file, and reading them needs nothing but arithmetic.
 *
 * This matters because `PUT /api/photos` otherwise takes the client's word
 * for `width`/`height`, and those numbers drive the masonry layout and the
 * public `PublicPhoto`. Now the bytes we actually stored get the last word.
 *
 * Returns `null` for anything it cannot read — a truncated header, an
 * unusual-but-valid variant, a format quirk. **`null` is not a failure**: the
 * caller falls back to the declared values, exactly as before. Refusing on
 * "we couldn't check" would turn a parser gap into a rejected upload, which
 * is a far worse trade than letting a hint stand.
 */
export function sniffImageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const type = sniffImageType(bytes);
  if (type === "image/jpeg") return jpegDimensions(bytes);
  if (type === "image/png") return pngDimensions(bytes);
  if (type === "image/webp") return webpDimensions(bytes);
  return null;
}

function readU16BE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 1 >= bytes.length) return null;
  return ((bytes[offset] as number) << 8) | (bytes[offset + 1] as number);
}

function readU32BE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 3 >= bytes.length) return null;
  return (
    (((bytes[offset] as number) << 24) |
      ((bytes[offset + 1] as number) << 16) |
      ((bytes[offset + 2] as number) << 8) |
      (bytes[offset + 3] as number)) >>>
    0
  );
}

/** Bounds the marker walk below. A real JPEG reaches its SOF within a
 * handful of segments; anything past this is a crafted file trying to make
 * us spin, and `null` (fall back to the declared values) is the right answer
 * for it either way. */
const MAX_JPEG_SEGMENTS = 128;

/**
 * Walks JPEG segments from offset 2 looking for a Start-Of-Frame marker,
 * whose payload carries height at +5 and width at +7.
 *
 * The walk is the point: a camera JPEG puts APP0/APP1 (JFIF, EXIF — often
 * several kilobytes of thumbnail) before the SOF, so reading a fixed offset
 * finds metadata rather than dimensions. `SOF0/1/2/3`, `SOF5/6/7`,
 * `SOF9/10/11` and `SOF13/14/15` are all frame headers with this layout;
 * `0xC4` (DHT), `0xC8` and `0xCC` share the range but are not.
 */
function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  let offset = 2;
  for (let segment = 0; segment < MAX_JPEG_SEGMENTS; segment += 1) {
    // Markers are 0xFF followed by a type byte; fill bytes (0xFF) may repeat.
    if (bytes[offset] !== 0xff) return null;
    let marker = bytes[offset + 1];
    let markerOffset = offset + 1;
    while (marker === 0xff) {
      markerOffset += 1;
      marker = bytes[markerOffset];
    }
    if (marker === undefined) return null;

    // Standalone markers with no length field.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset = markerOffset + 1;
      continue;
    }
    // Start of scan — entropy-coded data follows and there is no SOF ahead.
    if (marker === 0xda) return null;

    const length = readU16BE(bytes, markerOffset + 1);
    if (length === null || length < 2) return null;

    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      const height = readU16BE(bytes, markerOffset + 4);
      const width = readU16BE(bytes, markerOffset + 6);
      if (height === null || width === null || width < 1 || height < 1) return null;
      return { width, height };
    }

    offset = markerOffset + 1 + length;
  }
  return null;
}

/** PNG's IHDR is always the first chunk: 8-byte signature, 4-byte length,
 * 4-byte "IHDR", then width and height as big-endian u32. */
function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const width = readU32BE(bytes, 16);
  const height = readU32BE(bytes, 20);
  if (width === null || height === null || width < 1 || height < 1) return null;
  return { width, height };
}

/** WebP's dimensions live in the first chunk after the 12-byte RIFF header,
 * and the three chunk kinds each encode them differently. */
function webpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const fourCC = String.fromCharCode(...Array.from(bytes.subarray(12, 16)));

  if (fourCC === "VP8 ") {
    // Lossy: a 3-byte start code at 23..25, then 14-bit width and height.
    const width = readU16LE(bytes, 26);
    const height = readU16LE(bytes, 28);
    if (width === null || height === null) return null;
    return { width: width & 0x3fff, height: height & 0x3fff };
  }

  if (fourCC === "VP8L") {
    // Lossless: 1-byte signature at 20, then 14 bits of width and 14 of
    // height packed little-endian across the next four bytes, each stored
    // one less than the true value.
    const packed = readU32LE(bytes, 21);
    if (packed === null) return null;
    return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
  }

  if (fourCC === "VP8X") {
    // Extended: canvas size as two 24-bit little-endian values, each one
    // less than the true value.
    const width = readU24LE(bytes, 24);
    const height = readU24LE(bytes, 27);
    if (width === null || height === null) return null;
    return { width: width + 1, height: height + 1 };
  }

  return null;
}

function readU16LE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 1 >= bytes.length) return null;
  return (bytes[offset] as number) | ((bytes[offset + 1] as number) << 8);
}

function readU24LE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 2 >= bytes.length) return null;
  return (bytes[offset] as number) | ((bytes[offset + 1] as number) << 8) | ((bytes[offset + 2] as number) << 16);
}

function readU32LE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 3 >= bytes.length) return null;
  return (
    (((bytes[offset] as number) |
      ((bytes[offset + 1] as number) << 8) |
      ((bytes[offset + 2] as number) << 16) |
      ((bytes[offset + 3] as number) << 24)) >>>
      0)
  );
}

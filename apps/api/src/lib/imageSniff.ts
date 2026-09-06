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

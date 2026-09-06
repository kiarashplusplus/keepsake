/**
 * Opaque pagination cursors for `GET /api/feed` (`@keepsake/contracts/feed`'s
 * `CursorSchema` — just an opaque, bounded-length string as far as the
 * client is concerned). Two shapes, both base64url so they're safe as a
 * query-string value with no further escaping:
 *
 * - Keyset (default/category feed): `base64url("<published_at>:<id>")`.
 * - Bounded offset (search and geo modes): `base64url(String(offset))`.
 *
 * `atob`/`btoa` operate on Latin1 strings; every value encoded here (decimal
 * numbers, ULIDs) is already ASCII, so no UTF-8 step is needed.
 */
export function encodeBase64Url(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeBase64Url(input: string): string | null {
  try {
    const padded = input.replace(/-/g, "+").replace(/_/g, "/");
    const withPadding = padded.padEnd(Math.ceil(padded.length / 4) * 4, "=");
    return atob(withPadding);
  } catch {
    return null;
  }
}

export interface KeysetCursor {
  publishedAt: number;
  id: string;
}

export function encodeKeysetCursor(publishedAt: number, id: string): string {
  return encodeBase64Url(`${publishedAt}:${id}`);
}

/** Returns `null` for a missing, malformed, or corrupt cursor — treated the
 * same as "start from the top" rather than a 400, since a cursor is opaque
 * to the client and a stale/tampered one shouldn't break pagination. */
export function decodeKeysetCursor(cursor: string | undefined): KeysetCursor | null {
  if (!cursor) return null;
  const decoded = decodeBase64Url(cursor);
  if (decoded === null) return null;
  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex <= 0) return null;
  const publishedAt = Number.parseInt(decoded.slice(0, separatorIndex), 10);
  const id = decoded.slice(separatorIndex + 1);
  if (!Number.isFinite(publishedAt) || id.length === 0) return null;
  return { publishedAt, id };
}

export function encodeOffsetCursor(offset: number): string {
  return encodeBase64Url(String(offset));
}

/** Returns `0` (start from the top) for a missing, malformed, or negative
 * cursor — same "opaque, never trusted" treatment as the keyset cursor. */
export function decodeOffsetCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const decoded = decodeBase64Url(cursor);
  if (decoded === null) return 0;
  const offset = Number.parseInt(decoded, 10);
  return Number.isFinite(offset) && offset >= 0 ? offset : 0;
}

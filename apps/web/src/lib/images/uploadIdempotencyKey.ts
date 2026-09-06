/**
 * Stable idempotency key for a photo upload, derived from the source file's
 * own identity (name + size + lastModified) rather than randomness — so
 * retrying the exact same upload (e.g. after a flaky connection) reuses the
 * same key and the API's `X-Idempotency-Key` handling can no-op a duplicate
 * rather than creating a second photo row. FNV-1a, 32-bit, ported from
 * finderly's `uploadIdempotencyKey.ts`.
 */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function uploadIdempotencyKey(file: { name: string; size: number; lastModified: number }): string {
  const input = `${file.name}:${file.size}:${file.lastModified}`;
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

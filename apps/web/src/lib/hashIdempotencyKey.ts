/**
 * Deterministic hash for building an idempotency key out of arbitrary
 * strings (e.g. `${listingId}:${email}` for a request). FNV-1a, and not a
 * cryptographic hash, because the API only needs a stable dedup key (Turnstile plus the API's
 * own unique `(listing_id, email)` constraint carry the actual security),
 * and FNV-1a is synchronous, unlike `crypto.subtle.digest`, so a submit
 * handler doesn't need an extra `await` just to build a header value.
 */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function hashIdempotencyKey(input: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

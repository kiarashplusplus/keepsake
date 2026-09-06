/**
 * Minimal in-repo ULID generator (Crockford base32, no ambiguous I/L/O/U —
 * matches `UlidSchema` in `@keepsake/contracts/common` exactly: 26 chars,
 * `[0-9A-HJKMNP-TV-Z]`).
 *
 * A real `ulid` npm package would work too, but this is ~30 lines with no
 * dependency to audit or pin, and every ID this Worker mints (owners,
 * listings, photos, moderation events, recovery tokens) goes through it. Not
 * monotonic within the same millisecond — each call draws fresh randomness
 * rather than incrementing a counter — which is a deliberate simplification:
 * 80 bits of randomness per ID makes a same-millisecond collision
 * astronomically unlikely for this app's write volume, and monotonicity only
 * matters for tools that sort IDs lexicographically expecting insertion
 * order, which nothing here does (every table has its own `created_at`).
 */
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ENCODING_BASE = CROCKFORD_ALPHABET.length;
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

function encodeTime(timeMs: number, length: number): string {
  let remaining = timeMs;
  let out = "";
  for (let i = 0; i < length; i++) {
    const mod = remaining % ENCODING_BASE;
    out = CROCKFORD_ALPHABET[mod] + out;
    remaining = Math.floor(remaining / ENCODING_BASE);
  }
  return out;
}

function encodeRandom(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) {
    const byte = bytes[i];
    out += CROCKFORD_ALPHABET[(byte ?? 0) % ENCODING_BASE];
  }
  return out;
}

/** Generates a fresh ULID. `now` is injectable for tests; defaults to `Date.now()`. */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now, TIME_CHARS) + encodeRandom(RANDOM_CHARS);
}

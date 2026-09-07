import { todayISO } from "./day.js";

/** Full-length SHA-256 hex digest, used where truncation isn't wanted (owner
 * token hashing, idempotency scoping) — as opposed to
 * `src/moderation/budget.ts`'s deliberately truncated 128-bit digest, which
 * exists purely to keep KV keys short.
 *
 * Never hash a caller's IP address with this directly: use `dailyIpDigest`
 * below, which is the only shape the privacy page describes. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digestBuffer = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digestBuffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The one way this Worker is allowed to turn a caller's IP address into an
 * identifier: SHA-256 over `<UTC day>:<address>`, so the same address hashes
 * to something unrelated tomorrow.
 *
 * Issue #87: there used to be two shapes. `src/moderation/budget.ts` salted
 * its KV counter keys with the day, and `apps/site/public/privacy.html`'s
 * "Rate limiting" section describes exactly that ("hashed record of your IP
 * address combined with the date", worked example
 * `sha256("2026-09-05:203.0.113.4")`). But `middleware/rateLimit.ts`'s
 * `burst()` hashed the bare address, and `middleware/idempotency.ts` scoped
 * on the bare address too — a stable, never-rotating pseudonymous identifier
 * for one caller, with no expiry in its own construction. A bare SHA-256 of
 * an IPv4 address is brute-forceable either way (the page says so itself);
 * what the day buys is that two days' records can't be joined into a history
 * of one address, and that is the promise the page makes. One helper, so a
 * new call site can't quietly reintroduce the other shape — and
 * `tools/preflight/preflight.mjs`'s `ip-digest` check fails the build if one
 * tries.
 *
 * Full length rather than `budget.ts`'s truncated 128 bits: that truncation
 * exists to keep KV keys short, and `budget.ts` still takes the first 32 hex
 * characters of this same value, so both paths remain the same digest of the
 * same input.
 */
export async function dailyIpDigest(clientIP: string): Promise<string> {
  return sha256Hex(`${todayISO()}:${clientIP}`);
}

import { todayISO } from "./day.js";
import { toBase64Url } from "./tokens.js";

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

/**
 * The one way this Worker is allowed to turn a *recipient address* into a
 * counter key: SHA-256 over `<UTC day>:<lowercased address>`, the same
 * construction `dailyIpDigest` uses for addresses of the other kind, and for
 * the same reason — a key that rotates daily cannot be joined across days
 * into a history of one mailbox.
 *
 * Issue #188. The confirm-then-forward step means the only message a stranger
 * can aim at an address they don't own is the "was this you?" confirmation —
 * but one message per listing, across a public feed, is still a flood aimed at
 * a real person's inbox, and per-IP ceilings do not bound it (an attacker with
 * a /64 has a fresh ceiling per address, as `moderation/budget.ts`'s header
 * says of every per-IP number here). Bounding it needs a counter keyed by the
 * one identifier that *is* stable across the attack: the victim's address.
 *
 * Lowercased before hashing so `Victim@example.org` and `victim@example.org`
 * share a counter — otherwise the ceiling is bypassed by changing the case of
 * a letter, which is not a different mailbox anywhere it matters. No other
 * normalisation is attempted: dots-and-plus-tags differ per provider, and
 * guessing wrong would silently merge counters for mailboxes that are
 * genuinely distinct.
 */
export async function dailyEmailDigest(address: string): Promise<string> {
  return sha256Hex(`${todayISO()}:${address.trim().toLowerCase()}`);
}

/**
 * HMAC-SHA256 of `message` keyed by `secret`, base64url-encoded (same
 * alphabet `randomTokenRaw` uses — see `toBase64Url`). Built for
 * `src/email/unsubscribe.ts`'s per-recipient token, and the reason it exists
 * rather than reusing `sha256Hex` there: that token *is* the URL, mailed to
 * the recipient and read by every relay and scanner between here and their
 * inbox, unlike `email_events.to_hash`, which never leaves the database. A
 * bare `sha256Hex(address)` would be a dictionary lookup away from being
 * reversed — the same weakness #87's `dailyIpDigest` comment describes for a
 * bare hash of an IP — because a common email address is exactly the kind of
 * input a rainbow table is built for. Keying the digest on a server-side
 * secret closes that: recovering the address behind a token requires the
 * secret, not just a list of guesses.
 */
export async function hmacSha256(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toBase64Url(new Uint8Array(mac));
}

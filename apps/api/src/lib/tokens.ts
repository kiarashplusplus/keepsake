/**
 * Raw secret token generation, shared by every place this Worker mints a
 * bearer credential or a single-use link token: the owner token itself
 * (`ks_` + this), email-verify links, and recovery links. One
 * `crypto.getRandomValues` call, 32 bytes (256 bits) of entropy, base64url
 * without padding — 43 characters, matching `OwnerTokenSchema`'s documented
 * shape exactly (`@keepsake/contracts/owner`).
 *
 * Only the SHA-256 digest of whatever this returns is ever persisted
 * (`owners.token_hash`, `recovery_tokens.token_hash`) — the raw value exists
 * only for the instant it takes to hash it or put it in a URL handed
 * straight to the caller/an email provider.
 */
export function randomTokenRaw(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

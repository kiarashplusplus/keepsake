/**
 * Owner identity = a device-bound secret token, never an account. Minted
 * lazily on the first give action (never just from browsing — see the build
 * plan's "Owner token" section) and sent as `Authorization: Bearer <token>`
 * on every owner-scoped API call (`src/api/client.ts`'s `owner: true`).
 *
 * Format: `ks_` + base64url(32 random bytes), unpadded — 43 chars after the
 * prefix, matching `OwnerTokenSchema` in `@keepsake/contracts/owner`.
 */
import { OWNER_TOKEN_PREFIX, OwnerTokenSchema } from "@keepsake/contracts/owner";
import { secretStore } from "@/lib/secretStore";

export const OWNER_TOKEN_STORAGE_KEY = "keepsake.ownerToken.v1";

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  const base64 = btoa(binary);
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function mintOwnerToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `${OWNER_TOKEN_PREFIX}${toBase64Url(bytes)}`;
}

/** Returns the stored owner token, or `null` if none has been minted yet.
 * Never mints — use `getOrCreateOwnerToken()` for that. */
export function getOwnerToken(): string | null {
  const stored = secretStore.getItem(OWNER_TOKEN_STORAGE_KEY);
  if (stored === null) return null;
  return OwnerTokenSchema.safeParse(stored).success ? stored : null;
}

/** Mints a token on first call (persisting it) and returns the same token on
 * every subsequent call. Call this only from a give/edit action, never from
 * a page that's just being browsed. */
export function getOrCreateOwnerToken(): string {
  const existing = getOwnerToken();
  if (existing !== null) return existing;
  const minted = mintOwnerToken();
  secretStore.setItem(OWNER_TOKEN_STORAGE_KEY, minted);
  return minted;
}

export function setOwnerToken(token: string): void {
  secretStore.setItem(OWNER_TOKEN_STORAGE_KEY, token);
}

export function clearOwnerToken(): void {
  secretStore.removeItem(OWNER_TOKEN_STORAGE_KEY);
}

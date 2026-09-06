/**
 * Kiarash's one admin credential, held only for the life of a browser tab —
 * `sessionStorage`, never `localStorage` (see `src/lib/secretStore.web.ts`
 * for the owner token's equivalent, which deliberately DOES persist across
 * restarts; the admin token is the opposite choice on purpose, since this is
 * a single global secret with no per-device binding and no expiry of its
 * own, so a shared or borrowed browser shouldn't carry it past the tab that
 * typed it in). Nothing here ever mints a token — it's typed by hand on
 * `/admin` (`src/features/admin/AdminTokenGate.tsx`) and cleared with the
 * page's own "Forget" button or `clearAdminToken()`.
 */
export const ADMIN_TOKEN_STORAGE_KEY = "keepsake.adminToken.v1";

function hasSessionStorage(): boolean {
  return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined";
}

/** Returns the token typed in earlier this tab, or `null` if none is held
 * (never entered, cleared, or storage unavailable/blocked). */
export function getAdminToken(): string | null {
  if (!hasSessionStorage()) return null;
  try {
    return window.sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setAdminToken(token: string): void {
  if (!hasSessionStorage()) return;
  try {
    window.sessionStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
  } catch {
    // Private-browsing storage exceptions leave the token unpersisted for
    // this tab; the admin page still holds it in React state for the
    // current session, it just won't survive a reload.
  }
}

export function clearAdminToken(): void {
  if (!hasSessionStorage()) return;
  try {
    window.sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
  } catch {
    // See setAdminToken.
  }
}

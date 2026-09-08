/**
 * What an `<Image>` should load for a draft photo. One ladder, shared by the
 * photos step's tiles and the review step's cover print, so a photo that
 * survived a `sessionStorage` round trip looks the same on both screens:
 *
 * 1. the local object URL from this session's upload (instant, no request);
 * 2. else the owner-token-authed `/i/:id/thumb` route — the case after a
 *    reload, after leaving the flow and coming back, or a `?edit=` prefill,
 *    where the object URL is always `null` (`deserializeGiveDraft` clears it,
 *    since a blob URL does not survive the document it was minted in). The
 *    listing is not approved yet, so the route only answers with the owner's
 *    `Authorization` header; `expo-image` on web fetches with those headers
 *    itself and swaps in a blob URL;
 * 3. else nothing — the caller's blurhash placeholder stands alone. That
 *    used to be where every resumed tile stopped: a blur with no photo behind
 *    it, which read as "did that upload, or not?" rather than "your photo".
 */
import * as React from "react";
import type { GiveDraftPhoto } from "@/features/give/giveDraft";
import { getOwnerToken } from "@/lib/ownerToken";
import { config } from "@/lib/config";

export type DraftPhotoSource = { uri: string; headers?: Record<string, string> };

export function draftPhotoSource(
  photo: Pick<GiveDraftPhoto, "id" | "objectUrl"> | null,
): DraftPhotoSource | null {
  if (photo === null) return null;
  if (photo.objectUrl !== null) return { uri: photo.objectUrl };
  if (photo.id === null) return null;
  const origin = config.siteUrl || (typeof window !== "undefined" ? window.location.origin : "");
  const token = getOwnerToken();
  return {
    uri: `${origin}/i/${photo.id}/thumb`,
    ...(token !== null ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  };
}

/**
 * `draftPhotoSource`, memoised on the two fields it reads. `expo-image`'s
 * web `useHeaders` refetches whenever the `source` object's identity changes,
 * so handing it a fresh object every render (as the review step once did)
 * re-downloaded the thumb on every keystroke in the date-of-birth field.
 */
export function useDraftPhotoSource(
  photo: Pick<GiveDraftPhoto, "id" | "objectUrl"> | null,
): DraftPhotoSource | null {
  const missing = photo === null;
  const id = photo?.id ?? null;
  const objectUrl = photo?.objectUrl ?? null;
  return React.useMemo(
    () => draftPhotoSource(missing ? null : { id, objectUrl }),
    [missing, id, objectUrl],
  );
}

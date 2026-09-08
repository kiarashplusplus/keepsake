/**
 * What an `<Image>` should load for one bulk-batch photo tile — the same
 * three-rung ladder `features/give/photoSource.ts` already established, so
 * a photo looks the same whether it's mid-give-flow or mid-estate-upload:
 *
 * 1. this session's own object URL (`localPreviewUrl` below — never
 *    persisted, since a blob URL dies with the document that minted it, the
 *    same reason `deserializeGiveDraft` nulls it out on every rehydrate);
 * 2. else the owner-authed `/i/:id/thumb` route, once the photo has synced
 *    and carries a `urlThumb` — the case after a reload, or resuming a
 *    batch from a different sitting;
 * 3. else nothing — the caller's blurhash placeholder stands alone.
 *
 * The one thing this ladder adds beyond `give`'s: at up to 300 photos in one
 * batch, a screen cannot fire 300 authenticated `/thumb` fetches on mount —
 * see `useDraftPhotoSource` below, whose `enabled` flag exists for exactly
 * that, so a virtualized list can defer step 2 until a tile is actually
 * rendered. Nothing about the API needed to change for this: `/i/:id/thumb`
 * (`apps/api/src/routes/images.ts`) already answers one request at a time,
 * lazily, to whoever asks with the right owner token — this module just
 * gives the caller a way to *not* ask yet.
 */
import * as React from "react";
import { getOwnerToken } from "@/lib/ownerToken";

export type BulkPhotoSource = { uri: string; headers?: Record<string, string> };

export type BulkPhotoSourceInput = {
  /** This session's local preview, if one was minted for this photo (set on
   * intake, cleared once the queue's decode produces the real thumb, and
   * never written to `storage.ts` — see this file's header). `null` after a
   * reload. */
  localPreviewUrl: string | null;
  /** The server's `/i/:id/thumb` path, once this photo has synced
   * (`BatchPhotoSummary.url_thumb`, already resolved to an absolute URL by
   * `fixPhotoUrls` in `src/api/bulk.ts`). `null` before the first sync. */
  urlThumb: string | null;
};

export function bulkPhotoSource(photo: BulkPhotoSourceInput | null): BulkPhotoSource | null {
  if (photo === null) return null;
  if (photo.localPreviewUrl !== null) return { uri: photo.localPreviewUrl };
  if (photo.urlThumb === null) return null;
  const token = getOwnerToken();
  return {
    uri: photo.urlThumb,
    ...(token !== null ? { headers: { Authorization: `Bearer ${token}` } } : {}),
  };
}

/**
 * `bulkPhotoSource`, memoised on the fields it reads, and gated by
 * `enabled` — a virtualized tile list passes `false` for anything off-screen
 * so mounting 300 tiles doesn't resolve 300 authenticated URLs (and, for a
 * real `<Image>` component that fetches eagerly on receiving a `source`,
 * doesn't fire 300 requests) before a single one is visible. Building that
 * virtualization is the screens' job, per this module's header — this hook
 * only makes sure the data layer never forces the eager shape on them.
 */
export function useBulkPhotoSource(photo: BulkPhotoSourceInput | null, enabled = true): BulkPhotoSource | null {
  const missing = photo === null || !enabled;
  const localPreviewUrl = photo?.localPreviewUrl ?? null;
  const urlThumb = photo?.urlThumb ?? null;
  return React.useMemo(
    () => bulkPhotoSource(missing ? null : { localPreviewUrl, urlThumb }),
    [missing, localPreviewUrl, urlThumb],
  );
}

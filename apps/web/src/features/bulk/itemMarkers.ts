/**
 * The bulk workspace's own "human decided this" bookkeeping — the equivalent
 * of `giveDraft.ts`'s `titleDirty`/`appliedSuggestionPhotoId` and the API's
 * `category_chosen_at` (issue #155), for a draft item shape that has neither.
 *
 * `@keepsake/contracts/bulk`'s `DraftItemFields` and `batchStore.ts`'s
 * `BulkDraftItem` are both fixed — a wire contract and a reducer this agent
 * does not own — and neither carries a place to record "the giver already
 * chose this" or "this is the cover a suggestion was last applied for". That
 * fact has to live *somewhere* client-side, or a late-arriving suggestion
 * (or a re-fetch after regrouping) silently overwrites a title the giver
 * already edited, and a category correction gets clobbered the next time a
 * suggestion lands — exactly the failure #155 fixed for the ordinary give
 * flow. So it lives here, as a small side table keyed by `clientItemId`,
 * persisted per batch so it survives a reload across the several sittings
 * this feature is built for.
 *
 * Deliberately NOT modelled as part of `BulkBatchState` — nothing here is
 * server truth, nothing here is sent over the wire, and losing it (a
 * cleared browser, a different device) only ever costs "a suggestion might
 * re-offer something already dismissed", never data. That is why a plain
 * `localStorage`-backed blob, written on every marker change, is fine at
 * this size (bounded by `MAX_BATCH_ITEMS`, a few dozen bytes each) even
 * though `storage.ts` deliberately avoids exactly this pattern for the
 * batch draft itself — that file's whole point is that a draft's *content*
 * (title, story, photos) is too large and too precious to treat this way.
 * This is neither.
 */
import { secretStore } from "@/lib/secretStore";

export type ItemMarker = {
  /** The giver has typed their own title — an incoming suggestion must never
   * overwrite it, mirroring `GiveDraftPhoto`'s sibling flag. */
  titleDirty: boolean;
  /** The giver has chosen (or confirmed) a category by hand — issue #155's
   * rule, reimplemented client-side for a draft item: once true, a
   * suggestion may still be fetched (it's still useful for aspects/
   * condition) but must never touch `category` again. */
  categoryChosen: boolean;
  /** The `clientPhotoId` of the cover a suggestion was last applied for.
   * `null` until a suggestion has actually been applied. When this no
   * longer matches the item's current cover, the applied suggestion is
   * stale — its condition/markings note should stop showing, and a fresh
   * suggestion is worth fetching for the new cover. */
  appliedSuggestionPhotoId: string | null;
};

export const EMPTY_ITEM_MARKER: ItemMarker = {
  titleDirty: false,
  categoryChosen: false,
  appliedSuggestionPhotoId: null,
};

export type ItemMarkers = Record<string, ItemMarker>;

function storageKey(clientBatchKey: string): string {
  return `keepsake.bulk.markers.v1.${clientBatchKey}`;
}

function isItemMarker(value: unknown): value is ItemMarker {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.titleDirty === "boolean" && typeof v.categoryChosen === "boolean" && (v.appliedSuggestionPhotoId === null || typeof v.appliedSuggestionPhotoId === "string");
}

/** Never throws on a corrupt or foreign value — a marker blob is disposable
 * per this file's header, so the worst a bad read should ever cost is "no
 * markers this session", not a crashed workspace. */
export function loadItemMarkers(clientBatchKey: string): ItemMarkers {
  const raw = secretStore.getItem(storageKey(clientBatchKey));
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: ItemMarkers = {};
    for (const [clientItemId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isItemMarker(value)) out[clientItemId] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveItemMarkers(clientBatchKey: string, markers: ItemMarkers): void {
  try {
    secretStore.setItem(storageKey(clientBatchKey), JSON.stringify(markers));
  } catch {
    // Best-effort — see this file's header on why losing this costs nothing
    // beyond a possibly-redundant suggestion offer later.
  }
}

export function markerFor(markers: ItemMarkers, clientItemId: string): ItemMarker {
  return markers[clientItemId] ?? EMPTY_ITEM_MARKER;
}

/** True when the item's currently-applied suggestion (if any) was applied
 * for a cover photo other than the one it has now — the giver changed the
 * cover after a suggestion landed, so whatever it filled in was about a
 * different photo. */
export function isSuggestionStale(markers: ItemMarkers, clientItemId: string, currentCoverPhotoId: string | null): boolean {
  const marker = markerFor(markers, clientItemId);
  if (marker.appliedSuggestionPhotoId === null) return false;
  return marker.appliedSuggestionPhotoId !== currentCoverPhotoId;
}

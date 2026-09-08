/**
 * Pure photo-grouping arithmetic for the bulk workspace: given the current
 * batch state and a giver's grouping choice ("group these into one item",
 * "one item per photo", "move this photo over there", "make this the
 * cover"...), compute exactly which items' `photoClientIds` change and
 * which photos' `itemClientId` changes as a result — with no `fetch`, no
 * dispatch, no IndexedDB, so every grouping rule is testable against a
 * plain `BulkBatchState` fixture the same way `batchStore.test.ts` already
 * tests the reducer it plans for.
 *
 * `useBulkWorkspace.ts` is the only caller: it turns a `GroupingPlan` into
 * local `upsert_item_local`/`update_photo` dispatches (so the UI updates
 * instantly) and `upsertBatchItem` calls for `itemsToSave` (so the server
 * agrees). Deletion is not modelled here — `PUT .../items/:id` and `DELETE
 * .../items/:id` are different API calls with different semantics, so
 * "dissolve this item back into the tray" is `planDissolveItem` (no item to
 * save, just photos to release) plus the caller's own `deleteBatchItem`.
 *
 * One server fact this module exists to respect: `PUT
 * .../items/:clientItemId` overwrites `title`/`story`/`category`/`aspects`
 * with exactly what `fields` carries — see `apps/api/src/routes/bulk.ts`'s
 * item-upsert handler, which never merges an omitted key against the
 * existing row the way it does for `room_label`/`lot_label`. So every save
 * this module's plans produce must be paired with the item's *current*
 * `fields` by the caller, never a partial patch — this file only ever
 * touches `photoClientIds`, and leaves `fields` for `useBulkWorkspace.ts`
 * to carry through unchanged.
 */
import { MAX_PHOTOS } from "@keepsake/contracts/photo";
import { MAX_BATCH_ITEMS } from "@keepsake/contracts/bulk";
import { listItems, type BulkBatchState } from "@/features/bulk/batchStore";

export type ItemPhotoPatch = { clientItemId: string; photoClientIds: string[] };
export type PhotoOwnerPatch = { clientPhotoId: string; itemClientId: string | null };

export type GroupingPlan = {
  /** Every item whose `photoClientIds` must change locally. Includes items
   * losing a photo to a new owner, not only the one gaining it. */
  itemPatches: ItemPhotoPatch[];
  /** Every photo whose `itemClientId` must change locally to match. */
  photoPatches: PhotoOwnerPatch[];
  /** The subset of `itemPatches` that must actually be `PUT` to the server
   * — every *new* item, plus any *existing* item whose photo list changed
   * (an item that only lost photos still needs its own list resaved, or the
   * server's copy of it drifts from what the giver now sees). */
  itemsToSave: string[];
};

export type GroupingRefusal = { reason: string };

function currentOwner(state: BulkBatchState, clientPhotoId: string): string | null {
  for (const item of listItems(state)) {
    if (item.photoClientIds.includes(clientPhotoId)) return item.clientItemId;
  }
  return null;
}

function withoutPhotos(photoClientIds: string[], toRemove: ReadonlySet<string>): string[] {
  return photoClientIds.filter((id) => !toRemove.has(id));
}

/** The `itemPatches` for every *source* item that loses one or more of
 * `movedPhotoIds` to wherever each is headed — computed once from each
 * photo's *current* owner, independent of how many destinations there are,
 * so both "these five photos all move to one item" and "each of these five
 * photos moves to its own new item" share the same "detach from wherever it
 * was" arithmetic. A photo already unassigned (no current owner) needs no
 * source patch at all. */
function sourcePatchesForDetachment(state: BulkBatchState, movedPhotoIds: readonly string[]): ItemPhotoPatch[] {
  const bySource = new Map<string, Set<string>>();
  for (const photoClientId of movedPhotoIds) {
    const owner = currentOwner(state, photoClientId);
    if (owner === null) continue;
    const set = bySource.get(owner) ?? new Set<string>();
    set.add(photoClientId);
    bySource.set(owner, set);
  }

  const sourcePatches: ItemPhotoPatch[] = [];
  for (const [itemClientId, lost] of bySource) {
    const item = state.items[itemClientId];
    if (item === undefined) continue;
    sourcePatches.push({ clientItemId: itemClientId, photoClientIds: withoutPhotos(item.photoClientIds, lost) });
  }
  return sourcePatches;
}

/** Groups `photoClientIds` (2 or more, typically) into one brand-new item —
 * "Group as one item". `newItemClientId` is minted by the caller
 * (`makeClientId()`) so this stays pure. */
export function planGroupAsOneItem(
  state: BulkBatchState,
  newItemClientId: string,
  photoClientIds: readonly string[],
): GroupingPlan | GroupingRefusal {
  if (photoClientIds.length === 0) return { reason: "Select at least one photo first." };
  if (photoClientIds.length > MAX_PHOTOS) return { reason: `An item can hold at most ${MAX_PHOTOS} photos.` };
  if (listItems(state).length >= MAX_BATCH_ITEMS) return { reason: `This batch already has ${MAX_BATCH_ITEMS} items, the most a batch can hold.` };

  const sourcePatches = sourcePatchesForDetachment(state, photoClientIds);
  const photoPatches: PhotoOwnerPatch[] = photoClientIds.map((clientPhotoId) => ({ clientPhotoId, itemClientId: newItemClientId }));
  const itemPatches: ItemPhotoPatch[] = [{ clientItemId: newItemClientId, photoClientIds: [...photoClientIds] }, ...sourcePatches];
  return { itemPatches, photoPatches, itemsToSave: itemPatches.map((p) => p.clientItemId) };
}

/** Splits `photoClientIds` into one new item per photo — "One item per
 * photo". `makeItemClientId` is called once per photo so the caller
 * controls id generation (and can assert on how many were minted). */
export function planGroupOnePerPhoto(
  state: BulkBatchState,
  photoClientIds: readonly string[],
  makeItemClientId: () => string,
): GroupingPlan | GroupingRefusal {
  if (photoClientIds.length === 0) return { reason: "Select at least one photo first." };
  if (listItems(state).length + photoClientIds.length > MAX_BATCH_ITEMS) {
    return { reason: `That would put this batch over its ${MAX_BATCH_ITEMS}-item limit.` };
  }

  const newItemIds = photoClientIds.map(() => makeItemClientId());
  const perPhotoPatches: ItemPhotoPatch[] = photoClientIds.map((photoClientId, index) => ({
    clientItemId: newItemIds[index] as string,
    photoClientIds: [photoClientId],
  }));
  const sourcePatches = sourcePatchesForDetachment(state, photoClientIds);
  const photoPatches: PhotoOwnerPatch[] = photoClientIds.map((clientPhotoId, index) => ({
    clientPhotoId,
    itemClientId: newItemIds[index] as string,
  }));

  const itemPatches = [...perPhotoPatches, ...sourcePatches];
  return { itemPatches, photoPatches, itemsToSave: itemPatches.map((p) => p.clientItemId) };
}

/** Adds `photoClientIds` (already-uploaded tray photos, or photos pulled
 * off another item) onto an existing item. */
export function planAddPhotosToItem(
  state: BulkBatchState,
  itemClientId: string,
  photoClientIds: readonly string[],
): GroupingPlan | GroupingRefusal {
  const item = state.items[itemClientId];
  if (item === undefined) return { reason: "That item no longer exists." };
  const toAdd = photoClientIds.filter((id) => !item.photoClientIds.includes(id));
  if (toAdd.length === 0) return { itemPatches: [], photoPatches: [], itemsToSave: [] };
  if (item.photoClientIds.length + toAdd.length > MAX_PHOTOS) {
    return { reason: `An item can hold at most ${MAX_PHOTOS} photos.` };
  }

  const sourcePatches = sourcePatchesForDetachment(state, toAdd);
  const photoPatches: PhotoOwnerPatch[] = toAdd.map((clientPhotoId) => ({ clientPhotoId, itemClientId }));
  const destinationPatch: ItemPhotoPatch = { clientItemId: itemClientId, photoClientIds: [...item.photoClientIds, ...toAdd] };
  const itemPatches = [destinationPatch, ...sourcePatches];
  return { itemPatches, photoPatches, itemsToSave: itemPatches.map((p) => p.clientItemId) };
}

/** Removes one photo from an item, back to the unassigned tray. */
export function planRemovePhotoFromItem(state: BulkBatchState, itemClientId: string, clientPhotoId: string): GroupingPlan | GroupingRefusal {
  const item = state.items[itemClientId];
  if (item === undefined) return { reason: "That item no longer exists." };
  if (!item.photoClientIds.includes(clientPhotoId)) return { itemPatches: [], photoPatches: [], itemsToSave: [] };

  const photoClientIds = item.photoClientIds.filter((id) => id !== clientPhotoId);
  return {
    itemPatches: [{ clientItemId: itemClientId, photoClientIds }],
    photoPatches: [{ clientPhotoId, itemClientId: null }],
    itemsToSave: [itemClientId],
  };
}

/** Reorders an item's photos so `clientPhotoId` — which must already belong
 * to it — is first, i.e. the cover. No ownership changes, so no
 * `photoPatches`. */
export function planSetCoverPhoto(state: BulkBatchState, itemClientId: string, clientPhotoId: string): GroupingPlan | GroupingRefusal {
  const item = state.items[itemClientId];
  if (item === undefined) return { reason: "That item no longer exists." };
  if (!item.photoClientIds.includes(clientPhotoId)) return { reason: "That photo isn't part of this item." };
  if (item.photoClientIds[0] === clientPhotoId) return { itemPatches: [], photoPatches: [], itemsToSave: [] };

  const photoClientIds = [clientPhotoId, ...item.photoClientIds.filter((id) => id !== clientPhotoId)];
  return { itemPatches: [{ clientItemId: itemClientId, photoClientIds }], photoPatches: [], itemsToSave: [itemClientId] };
}

/** Dissolves an item entirely: every one of its photos returns to the tray.
 * Deliberately produces no `itemsToSave` — the item itself is deleted
 * (`deleteBatchItem`, the caller's job, per this file's header), not
 * resaved with an empty photo list. */
export function planDissolveItem(state: BulkBatchState, itemClientId: string): { photoPatches: PhotoOwnerPatch[] } {
  const item = state.items[itemClientId];
  if (item === undefined) return { photoPatches: [] };
  return { photoPatches: item.photoClientIds.map((clientPhotoId) => ({ clientPhotoId, itemClientId: null })) };
}

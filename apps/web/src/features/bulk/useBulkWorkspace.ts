/**
 * The bulk workspace: one hook that wires `batchStore.ts`'s reducer,
 * `storage.ts`'s IndexedDB persistence, `uploadQueue.ts`'s upload pipeline
 * and `src/api/bulk.ts`'s typed client together into the operations the
 * screens under `app/bulk/[batchKey]/` actually call — create/update the
 * batch, add and group photos, edit and save items, run and apply a cover
 * suggestion, "apply to selected", and submit.
 *
 * Consumes the four fixed modules; adds none of its own reducer actions —
 * every local mutation is expressed as `upsert_item_local`/`update_photo`/
 * `add_photo`/`remove_*` dispatches the existing reducer already knows how
 * to apply, per `batchStore.ts`'s own header ("a future `BulkBatchContext`
 * stays a thin `useReducer` + effect pair over this module").
 *
 * ## Why every item save resends the item's *whole* `fields`
 *
 * `PUT /api/bulk/batches/:id/items/:clientItemId` overwrites
 * `title`/`story`/`category`/`aspects` with exactly what `fields` carries —
 * unlike `room_label`/`lot_label`, an omitted key is not "leave unchanged"
 * (see `apps/api/src/routes/bulk.ts`'s handler). So `pushItemToServer` below
 * always reads the item's *current* local `fields` out of the reducer and
 * sends the whole object, even for a save that only changed which photos
 * belong to it — never a `{title: "..."}` sliver that would silently wipe
 * the story next to it.
 *
 * ## "Human chose this" markers
 *
 * `itemMarkers.ts` is this file's only non-fixed dependency for that part:
 * neither the wire contract nor `BulkDraftItem` has anywhere to record "the
 * giver typed their own title" or "the giver picked this category on
 * purpose" (issue #155, for a draft item shape that predates this feature).
 * `requestSuggestion` below is the one place that reads and updates markers.
 */
import * as React from "react";
import type { Category } from "@keepsake/contracts/listing";
import { STORY_MAX } from "@keepsake/contracts/listing";
import { MAX_BATCH_PHOTOS, type BatchItemSummary, type BulkOperationSummary, type DraftItemFields, type UpdateBatchInput, type UpsertBatchItemInput } from "@keepsake/contracts/bulk";
import type { PhotoSuggestion } from "@keepsake/contracts/photo";
import {
  batchMetaFromSummary,
  bulkBatchReducer,
  emptyBulkBatchState,
  itemFromSummary,
  makeBulkBatchMeta,
  makeBulkDraftPhoto,
  pendingUploadPhotos,
  photoFromSummary,
  type BulkBatchMeta,
  type BulkBatchState,
  type BulkDraftPhoto,
} from "@/features/bulk/batchStore";
import {
  clearBatch,
  deleteItemRecord,
  deletePhotoRecord,
  getDefaultBulkStorageDriver,
  loadBatchState,
  saveBatchMeta,
  savePhoto,
  savePhotoMeta,
  saveItem as persistItemRecord,
  type BulkStorageDriver,
} from "@/features/bulk/storage";
import { UploadQueue } from "@/features/bulk/uploadQueue";
import {
  planAddPhotosToItem,
  planDissolveItem,
  planGroupAsOneItem,
  planGroupOnePerPhoto,
  planRemovePhotoFromItem,
  planSetCoverPhoto,
  type GroupingPlan,
  type PhotoOwnerPatch,
} from "@/features/bulk/grouping";
import { isSuggestionStale, loadItemMarkers, markerFor, saveItemMarkers, type ItemMarker, type ItemMarkers } from "@/features/bulk/itemMarkers";
import * as bulkApi from "@/api/bulk";
import type { BulkResult, BulkWriteError } from "@/api/bulk";
import { ApiError } from "@/api/client";

/** Exported so `app/bulk/new.tsx` can mint the `client_batch_key` a fresh
 * batch is addressed by, before a `BulkWorkspaceProvider` for it exists. */
export function makeBulkClientId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Renders a `BulkWriteError` (or a thrown `ApiError`) into one sentence a
 * giver can read — the same idea as `uploadQueue.ts`'s failure
 * classification, but for the item/batch write paths that module doesn't
 * cover. */
export function describeBulkFailure(error: BulkWriteError): string {
  return error.message;
}

export type BulkWorkspaceStatus =
  | "loading"
  | "ready"
  /** Nothing on this device or the server knows this batch. */
  | "not_found"
  /** The API answered every read with `not_found` — `BULK_UPLOAD` is off,
   * or this device holds no usable grant/owner token for it. Screens must
   * degrade honestly here rather than looking broken (see this feature's
   * plan). */
  | "unavailable";

export type SuggestionPreview = {
  itemClientId: string;
  title: string;
  before: string;
  after: string;
  /** True when applying would do nothing useful (no shared story set,
   * already present, or would exceed `STORY_MAX`) — `reason` says why. */
  skipped: boolean;
  reason: string | null;
};

export type UseBulkWorkspaceResult = {
  status: BulkWorkspaceStatus;
  state: BulkBatchState;
  grantId: string;
  setGrantId: (grantId: string) => void;
  markers: ItemMarkers;
  markerFor: (clientItemId: string) => ItemMarker;
  isSuggestionStale: (clientItemId: string) => boolean;
  suggestionLoading: Record<string, boolean>;
  uploadPausedUntil: number | null;

  // batch
  updateBatchMeta: (patch: { name?: string; sharedStory?: string | null }) => Promise<BulkResult<BulkBatchMeta> | null>;
  cancelBatch: () => Promise<BulkResult<{ id: string }>>;

  // photos
  addPhotos: (files: File[]) => Promise<void>;
  removePhoto: (clientPhotoId: string) => Promise<void>;
  retryPhoto: (clientPhotoId: string, file: File) => void;

  // grouping
  groupAsOneItem: (photoClientIds: string[]) => Promise<{ ok: boolean; error?: string; itemClientId?: string }>;
  groupOnePerPhoto: (photoClientIds: string[]) => Promise<{ ok: boolean; error?: string }>;
  addPhotosToItem: (itemClientId: string, photoClientIds: string[]) => Promise<{ ok: boolean; error?: string }>;
  removePhotoFromItem: (itemClientId: string, clientPhotoId: string) => Promise<{ ok: boolean; error?: string }>;
  setCoverPhoto: (itemClientId: string, clientPhotoId: string) => Promise<{ ok: boolean; error?: string }>;
  dissolveItem: (itemClientId: string) => Promise<void>;

  // item fields
  setItemTitle: (itemClientId: string, title: string) => void;
  setItemStory: (itemClientId: string, story: string) => void;
  setItemCategory: (itemClientId: string, category: Category) => void;
  setItemLabels: (itemClientId: string, patch: { roomLabel?: string | null; lotLabel?: string | null }) => void;
  saveItem: (itemClientId: string) => Promise<BulkResult<BatchItemSummary> | null>;

  // suggestions
  requestSuggestion: (itemClientId: string) => Promise<void>;
  suggestionForPhoto: (clientPhotoId: string) => PhotoSuggestion | null;

  // apply to selected
  applyRoomLabelToSelected: (itemClientIds: string[], roomLabel: string | null) => Promise<void>;
  applyLotLabelToSelected: (itemClientIds: string[], lotLabel: string | null) => Promise<void>;
  previewSharedStoryApplication: (itemClientIds: string[]) => SuggestionPreview[];
  applySharedStoryToSelected: (itemClientIds: string[]) => Promise<{ applied: number; skipped: number }>;

  // submission
  operations: BulkOperationSummary[];
  refreshOperations: () => Promise<void>;
  submitItems: (itemClientIds: string[], dateOfBirth: string) => Promise<BulkResult<BulkOperationSummary>>;
};

function totalPhotoCount(state: BulkBatchState): number {
  return Object.keys(state.photos).length;
}

/** Loads a batch this device has never persisted, from the server, by
 * scanning `listBatches()` for a matching `client_batch_key` — the
 * "continue preparing from a different browser (but the same, device-bound
 * owner token)" and "local storage got cleared mid-batch" cases. Returns
 * `null` when the server genuinely has nothing under this key either.
 * Thrown `ApiError`s with code `not_found` are treated as "not there"; any
 * other are rethrown for the caller to classify as `"unavailable"`. */
async function fetchBatchStateFromServer(clientBatchKey: string): Promise<BulkBatchState | null> {
  const summaries = await bulkApi.listBatches();
  const summary = summaries.find((s) => s.client_batch_key === clientBatchKey);
  if (summary === undefined) return null;
  const detail = await bulkApi.getBatch(summary.id);
  const meta = batchMetaFromSummary(clientBatchKey, detail);
  const items: BulkBatchState["items"] = {};
  const itemOrder: string[] = [];
  for (const itemSummary of detail.items) {
    items[itemSummary.client_item_id] = itemFromSummary(itemSummary);
    itemOrder.push(itemSummary.client_item_id);
  }
  const photos: BulkBatchState["photos"] = {};
  for (const photoSummary of detail.photos) {
    photos[photoSummary.client_photo_id] = photoFromSummary(photoSummary, null);
  }
  return { batch: meta, items, itemOrder, photos };
}

async function persistWholeState(driver: BulkStorageDriver, state: BulkBatchState): Promise<void> {
  await saveBatchMeta(driver, state.batch);
  for (const item of Object.values(state.items)) await persistItemRecord(driver, state.batch.clientBatchKey, item);
  for (const photo of Object.values(state.photos)) await savePhotoMeta(driver, state.batch.clientBatchKey, photo);
}

export function useBulkWorkspace(clientBatchKey: string, initialGrantId: string): UseBulkWorkspaceResult {
  const driver = React.useMemo(() => getDefaultBulkStorageDriver(), []);
  const [status, setStatus] = React.useState<BulkWorkspaceStatus>("loading");
  const [state, dispatch] = React.useReducer(
    bulkBatchReducer,
    clientBatchKey,
    (key) => emptyBulkBatchState(makeBulkBatchMeta(key, { name: "", country: "US", postalCode: "" })),
  );
  const [grantId, setGrantIdState] = React.useState(initialGrantId);
  const [markers, setMarkers] = React.useState<ItemMarkers>(() => loadItemMarkers(clientBatchKey));
  const [suggestions, setSuggestions] = React.useState<Record<string, PhotoSuggestion>>({});
  const [suggestionLoading, setSuggestionLoading] = React.useState<Record<string, boolean>>({});
  const [operations, setOperations] = React.useState<BulkOperationSummary[]>([]);
  const [uploadPausedUntil, setUploadPausedUntil] = React.useState<number | null>(null);

  const stateRef = React.useRef(state);
  React.useEffect(() => {
    stateRef.current = state;
  }, [state]);
  /**
   * Every local mutation in this hook goes through this instead of the raw
   * `dispatch` — it applies `bulkBatchReducer` to `stateRef.current`
   * *synchronously*, then also dispatches the same action for React's own
   * state. Without the synchronous half, a caller that dispatches and then
   * immediately reads `stateRef.current` (every grouping/save helper below
   * does exactly that, e.g. "create this item locally, then `PUT` it")
   * would read the *previous* render's state — React defers the reducer
   * call itself until the next render commits, and the `useEffect` above
   * that mirrors `state` into `stateRef` runs later still. The reducer is
   * pure, so computing it twice (once here, once inside React) can never
   * disagree.
   */
  function dispatchSync(action: Parameters<typeof bulkBatchReducer>[1]): void {
    stateRef.current = bulkBatchReducer(stateRef.current, action);
    dispatch(action);
  }
  const markersRef = React.useRef(markers);
  React.useEffect(() => {
    markersRef.current = markers;
    saveItemMarkers(clientBatchKey, markers);
  }, [clientBatchKey, markers]);
  const grantIdRef = React.useRef(grantId);
  React.useEffect(() => {
    grantIdRef.current = grantId;
    uploadQueueRef.current?.setGrantId(grantId);
  }, [grantId]);

  const attemptedSuggestionRef = React.useRef<Set<string>>(new Set());
  const objectUrlsRef = React.useRef<Set<string>>(new Set());
  const uploadQueueRef = React.useRef<UploadQueue | null>(null);

  // ---------------------------------------------------------------------
  // Load: local storage first, then a server fallback (see the function's
  // own header), so "this device has never seen this batch" and "this
  // batch genuinely doesn't exist / the feature is off" read differently.
  // ---------------------------------------------------------------------
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const local = await loadBatchState(driver, clientBatchKey);
      if (cancelled) return;
      if (local !== null) {
        dispatchSync({ type: "hydrate", state: local });
        setStatus("ready");
        return;
      }
      try {
        const fetched = await fetchBatchStateFromServer(clientBatchKey);
        if (cancelled) return;
        if (fetched === null) {
          setStatus("not_found");
          return;
        }
        await persistWholeState(driver, fetched);
        if (cancelled) return;
        dispatchSync({ type: "hydrate", state: fetched });
        setStatus("ready");
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.code === "not_found") {
          setStatus("unavailable");
          return;
        }
        setStatus("not_found");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientBatchKey]);

  // Revoke every object URL this session minted, on unmount — the private-
  // preview requirement this feature's plan calls out explicitly. `Print`
  // tiles never persist these (see `photoSource.ts`), so this is the only
  // place they're released.
  React.useEffect(() => {
    const urls = objectUrlsRef.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  // ---------------------------------------------------------------------
  // Upload queue
  // ---------------------------------------------------------------------
  React.useEffect(() => {
    if (status !== "ready" || state.batch.id === null) return undefined;
    const batchId = state.batch.id;
    const queue = new UploadQueue({
      batchKey: clientBatchKey,
      driver,
      uploadPhoto: ({ clientPhotoId, full, thumb, width, height, blurhash, signal }) =>
        bulkApi.uploadBatchPhoto(batchId, clientPhotoId, { full, thumb, width, height, blurhash }, { grantId: grantIdRef.current, signal }),
      onPhotoUpdate: (clientPhotoId, patch) => {
        dispatchSync({ type: "update_photo", clientPhotoId, patch });
        const photo = stateRef.current.photos[clientPhotoId];
        if (photo !== undefined) void savePhotoMeta(driver, clientBatchKey, { ...photo, ...patch });
      },
      onPhotoSynced: (summary) => dispatchSync({ type: "photo_synced", summary }),
      onPause: (resumeAt) => setUploadPausedUntil(resumeAt),
      onResume: () => setUploadPausedUntil(null),
    });
    queue.setGrantId(grantIdRef.current);
    uploadQueueRef.current = queue;
    void queue.resume(pendingUploadPhotos(stateRef.current));
    return () => {
      queue.destroy();
      uploadQueueRef.current = null;
    };
    // Only re-armed when the batch's server id first appears or the status
    // flips to ready — not on every `state` change, or every dispatch would
    // tear down and rebuild the whole pipeline mid-upload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, state.batch.id, clientBatchKey]);

  const setGrantId = React.useCallback((next: string) => setGrantIdState(next), []);

  // ---------------------------------------------------------------------
  // Batch meta
  // ---------------------------------------------------------------------
  const updateBatchMeta = React.useCallback(
    async (patch: { name?: string; sharedStory?: string | null }): Promise<BulkResult<BulkBatchMeta> | null> => {
      const meta = stateRef.current.batch;
      if (meta.id === null || meta.revision === null) return null;
      const input: UpdateBatchInput = {
        expected_revision: meta.revision,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.sharedStory !== undefined ? { shared_story: patch.sharedStory } : {}),
      };
      const result = await bulkApi.updateBatch(meta.id, input, { grantId: grantIdRef.current });
      if (result.ok) {
        const nextMeta = batchMetaFromSummary(clientBatchKey, result.data);
        dispatchSync({ type: "batch_synced", summary: result.data });
        await saveBatchMeta(driver, nextMeta);
        return { ok: true, data: nextMeta };
      }
      return result;
    },
    [clientBatchKey, driver],
  );

  const cancelBatchFn = React.useCallback(async (): Promise<BulkResult<{ id: string }>> => {
    const meta = stateRef.current.batch;
    if (meta.id === null) return { ok: false, error: { kind: "unexpected", message: "Nothing to cancel yet.", code: "not_found", status: 404 } };
    const result = await bulkApi.cancelBatch(meta.id, { grantId: grantIdRef.current });
    if (result.ok) {
      dispatchSync({ type: "patch_batch_meta", patch: { state: "cancelled" } });
      await saveBatchMeta(driver, { ...stateRef.current.batch, state: "cancelled" });
    }
    return result.ok ? { ok: true, data: { id: result.data.id } } : result;
  }, [driver]);

  // ---------------------------------------------------------------------
  // Item saves — always the item's whole current `fields`, per this file's
  // header.
  // ---------------------------------------------------------------------
  const pushItemToServer = React.useCallback(
    async (clientItemId: string, extra?: { photoClientIds?: string[] }): Promise<BulkResult<BatchItemSummary>> => {
      const meta = stateRef.current.batch;
      const item = stateRef.current.items[clientItemId];
      if (meta.id === null || item === undefined) {
        return { ok: false, error: { kind: "unexpected", message: "This batch isn't ready yet.", code: "internal", status: 0 } };
      }
      const input: UpsertBatchItemInput = {
        fields: item.fields,
        room_label: item.roomLabel,
        lot_label: item.lotLabel,
        ...(item.revision !== null ? { expected_revision: item.revision } : {}),
        ...(extra?.photoClientIds !== undefined ? { photo_client_ids: extra.photoClientIds } : {}),
      };
      const result = await bulkApi.upsertBatchItem(meta.id, clientItemId, input, { grantId: grantIdRef.current });
      if (result.ok) {
        dispatchSync({ type: "item_synced", summary: result.data });
        await persistItemRecord(driver, clientBatchKey, itemFromSummary(result.data));
      } else if (result.error.kind === "conflict") {
        dispatchSync({ type: "item_sync_failed", clientItemId });
      }
      return result;
    },
    [clientBatchKey, driver],
  );

  const saveItem = React.useCallback(
    (clientItemId: string) => pushItemToServer(clientItemId),
    [pushItemToServer],
  );

  // ---------------------------------------------------------------------
  // Photo intake
  // ---------------------------------------------------------------------
  const addPhotos = React.useCallback(
    async (files: File[]): Promise<void> => {
      for (const file of files) {
        if (totalPhotoCount(stateRef.current) >= MAX_BATCH_PHOTOS) break;
        const clientPhotoId = makeBulkClientId("photo");
        const previewUrl = URL.createObjectURL(file);
        objectUrlsRef.current.add(previewUrl);
        const photo = makeBulkDraftPhoto(clientPhotoId, { localPreviewUrl: previewUrl });
        dispatchSync({ type: "add_photo", photo });
        await savePhoto(driver, clientBatchKey, photo, file);
        uploadQueueRef.current?.enqueue(clientPhotoId, file);
      }
    },
    [clientBatchKey, driver],
  );

  const removePhoto = React.useCallback(
    async (clientPhotoId: string): Promise<void> => {
      const photo = stateRef.current.photos[clientPhotoId];
      uploadQueueRef.current?.cancel(clientPhotoId);
      if (photo?.localPreviewUrl !== null && photo?.localPreviewUrl !== undefined) {
        URL.revokeObjectURL(photo.localPreviewUrl);
        objectUrlsRef.current.delete(photo.localPreviewUrl);
      }
      if (photo !== undefined && photo.itemClientId !== null) {
        const plan = planRemovePhotoFromItem(stateRef.current, photo.itemClientId, clientPhotoId);
        if (!("reason" in plan)) {
          applyLocalPlan(plan);
          for (const itemClientId of plan.itemsToSave) await pushItemToServer(itemClientId, photoClientIdsExtra(plan, itemClientId));
        }
      }
      dispatchSync({ type: "remove_photo", clientPhotoId });
      await deletePhotoRecord(driver, clientBatchKey, clientPhotoId);
      const meta = stateRef.current.batch;
      if (meta.id !== null && photo !== undefined) {
        await bulkApi.deleteBatchPhoto(meta.id, clientPhotoId, { grantId: grantIdRef.current });
      }
    },
    // `applyLocalPlan` is a plain function declaration below (not a
    // `useCallback`) that only closes over `dispatch`/refs/`driver`/
    // `clientBatchKey` — all stable across the life of this hook — so
    // omitting it from the deps array never reads a stale closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clientBatchKey, driver, pushItemToServer],
  );

  const retryPhoto = React.useCallback((clientPhotoId: string, file: File) => {
    dispatchSync({ type: "update_photo", clientPhotoId, patch: { status: "queued", error: null, errorCode: null, canRetry: false } });
    uploadQueueRef.current?.retry(clientPhotoId, file);
  }, []);

  // ---------------------------------------------------------------------
  // Grouping — dispatch locally, persist locally, then push every changed
  // item to the server. `applyLocalPlan` is the one place `GroupingPlan`
  // turns into reducer dispatches + `storage.ts` writes.
  // ---------------------------------------------------------------------
  function photoClientIdsExtra(plan: GroupingPlan, clientItemId: string): { photoClientIds?: string[] } {
    const found = plan.itemPatches.find((p) => p.clientItemId === clientItemId)?.photoClientIds;
    return found !== undefined ? { photoClientIds: found } : {};
  }

  function applyLocalPlan(plan: GroupingPlan): void {
    for (const patch of plan.itemPatches) {
      dispatchSync({ type: "upsert_item_local", clientItemId: patch.clientItemId, patch: { photoClientIds: patch.photoClientIds } });
    }
    persistPhotoOwnerPatches(plan.photoPatches);
    for (const patch of plan.photoPatches) {
      dispatchSync({ type: "update_photo", clientPhotoId: patch.clientPhotoId, patch: { itemClientId: patch.itemClientId } });
    }
  }

  function persistPhotoOwnerPatches(patches: readonly PhotoOwnerPatch[]): void {
    for (const patch of patches) {
      const photo = stateRef.current.photos[patch.clientPhotoId];
      if (photo === undefined) continue;
      void savePhotoMeta(driver, clientBatchKey, { ...photo, itemClientId: patch.itemClientId });
    }
  }

  const commitGroupingPlan = React.useCallback(
    async (plan: GroupingPlan): Promise<{ ok: boolean; error?: string }> => {
      applyLocalPlan(plan);
      for (const clientItemId of plan.itemsToSave) {
        const result = await pushItemToServer(clientItemId, photoClientIdsExtra(plan, clientItemId));
        if (!result.ok) return { ok: false, error: describeBulkFailure(result.error) };
      }
      return { ok: true };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pushItemToServer],
  );

  const groupAsOneItem = React.useCallback(
    async (photoClientIds: string[]): Promise<{ ok: boolean; error?: string; itemClientId?: string }> => {
      const newItemClientId = makeBulkClientId("item");
      const plan = planGroupAsOneItem(stateRef.current, newItemClientId, photoClientIds);
      if ("reason" in plan) return { ok: false, error: plan.reason };
      const result = await commitGroupingPlan(plan);
      if (result.ok) void requestSuggestionInternal(newItemClientId);
      return { ...result, itemClientId: newItemClientId };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commitGroupingPlan],
  );

  const groupOnePerPhoto = React.useCallback(
    async (photoClientIds: string[]): Promise<{ ok: boolean; error?: string }> => {
      const newIds: string[] = [];
      const plan = planGroupOnePerPhoto(stateRef.current, photoClientIds, () => {
        const id = makeBulkClientId("item");
        newIds.push(id);
        return id;
      });
      if ("reason" in plan) return { ok: false, error: plan.reason };
      const result = await commitGroupingPlan(plan);
      if (result.ok) for (const id of newIds) void requestSuggestionInternal(id);
      return result;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commitGroupingPlan],
  );

  const addPhotosToItem = React.useCallback(
    async (itemClientId: string, photoClientIds: string[]): Promise<{ ok: boolean; error?: string }> => {
      const plan = planAddPhotosToItem(stateRef.current, itemClientId, photoClientIds);
      if ("reason" in plan) return { ok: false, error: plan.reason };
      return commitGroupingPlan(plan);
    },
    [commitGroupingPlan],
  );

  const removePhotoFromItem = React.useCallback(
    async (itemClientId: string, clientPhotoId: string): Promise<{ ok: boolean; error?: string }> => {
      const plan = planRemovePhotoFromItem(stateRef.current, itemClientId, clientPhotoId);
      if ("reason" in plan) return { ok: false, error: plan.reason };
      return commitGroupingPlan(plan);
    },
    [commitGroupingPlan],
  );

  const setCoverPhoto = React.useCallback(
    async (itemClientId: string, clientPhotoId: string): Promise<{ ok: boolean; error?: string }> => {
      const plan = planSetCoverPhoto(stateRef.current, itemClientId, clientPhotoId);
      if ("reason" in plan) return { ok: false, error: plan.reason };
      const result = await commitGroupingPlan(plan);
      // A new cover invalidates whatever suggestion note was showing
      // (`isSuggestionStale`, keyed on the marker's `appliedSuggestionPhotoId`
      // vs. the item's photo at index 0) and is worth a fresh autofill.
      if (result.ok) void requestSuggestionInternal(itemClientId);
      return result;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commitGroupingPlan],
  );

  const dissolveItem = React.useCallback(
    async (itemClientId: string): Promise<void> => {
      const { photoPatches } = planDissolveItem(stateRef.current, itemClientId);
      persistPhotoOwnerPatches(photoPatches);
      for (const patch of photoPatches) {
        dispatchSync({ type: "update_photo", clientPhotoId: patch.clientPhotoId, patch: { itemClientId: null } });
      }
      dispatchSync({ type: "remove_item", clientItemId: itemClientId });
      await deleteItemRecord(driver, clientBatchKey, itemClientId);
      const meta = stateRef.current.batch;
      if (meta.id !== null) await bulkApi.deleteBatchItem(meta.id, itemClientId, { grantId: grantIdRef.current });
    },
    // See `removePhoto`'s identical comment: `persistPhotoOwnerPatches` only
    // closes over stable values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clientBatchKey, driver],
  );

  // ---------------------------------------------------------------------
  // Item fields — local edit + the human-choice marker, per this file's
  // header.
  // ---------------------------------------------------------------------
  function setMarker(itemClientId: string, update: (marker: ItemMarker) => ItemMarker): void {
    setMarkers((prev) => ({ ...prev, [itemClientId]: update(markerFor(prev, itemClientId)) }));
  }

  const setItemTitle = React.useCallback((itemClientId: string, title: string) => {
    dispatchSync({ type: "upsert_item_local", clientItemId: itemClientId, patch: { fields: { title } } });
    setMarker(itemClientId, (m) => ({ ...m, titleDirty: true }));
  }, []);

  const setItemStory = React.useCallback((itemClientId: string, story: string) => {
    dispatchSync({ type: "upsert_item_local", clientItemId: itemClientId, patch: { fields: { story } } });
  }, []);

  const setItemCategory = React.useCallback((itemClientId: string, category: Category) => {
    dispatchSync({ type: "upsert_item_local", clientItemId: itemClientId, patch: { fields: { category } } });
    // Re-chosen or first-chosen, it stamps — issue #155's rule: the column
    // records that a human decided, not that they changed anything.
    setMarker(itemClientId, (m) => ({ ...m, categoryChosen: true }));
  }, []);

  const setItemLabels = React.useCallback((itemClientId: string, patch: { roomLabel?: string | null; lotLabel?: string | null }) => {
    dispatchSync({ type: "upsert_item_local", clientItemId: itemClientId, patch });
  }, []);

  // ---------------------------------------------------------------------
  // Suggestions
  // ---------------------------------------------------------------------
  /**
   * `force` distinguishes the automatic autofill this hook fires after
   * grouping/re-covering (deduped per `${itemClientId}:${coverPhotoId}`, so
   * a re-render or a second automatic trigger for the same cover never
   * re-asks) from a giver's own manual "Suggest"/"Try again" — which must
   * always be allowed to ask again, including right after an automatic
   * attempt just failed for the same cover. Either way the attempt is
   * still recorded afterward, so a *later automatic* trigger for that same
   * cover stays deduped.
   */
  async function requestSuggestionInternal(itemClientId: string, options: { force?: boolean } = {}): Promise<void> {
    const meta = stateRef.current.batch;
    const item = stateRef.current.items[itemClientId];
    if (meta.id === null || item === undefined) return;
    const coverClientPhotoId = item.photoClientIds[0];
    if (coverClientPhotoId === undefined) return;
    const coverPhoto = stateRef.current.photos[coverClientPhotoId];
    if (coverPhoto === undefined || coverPhoto.photoId === null) return; // not uploaded yet

    const attemptKey = `${itemClientId}:${coverClientPhotoId}`;
    if (!options.force && attemptedSuggestionRef.current.has(attemptKey)) return;
    attemptedSuggestionRef.current.add(attemptKey);

    setSuggestionLoading((s) => ({ ...s, [itemClientId]: true }));
    const result = await bulkApi.suggestBatchPhoto(meta.id, coverClientPhotoId, { grantId: grantIdRef.current });
    setSuggestionLoading((s) => ({ ...s, [itemClientId]: false }));
    // A failed or unavailable suggestion (kind !== "ok", or ok with a null
    // model answer) must never block review/submission — the item is left
    // exactly as editable as before, per this feature's plan.
    if (!result.ok || result.data === null) return;

    const suggestion = result.data;
    setSuggestions((s) => ({ ...s, [coverClientPhotoId]: suggestion }));

    const currentItem = stateRef.current.items[itemClientId];
    if (currentItem === undefined) return;
    const marker = markerFor(markersRef.current, itemClientId);
    const fieldPatch: Partial<DraftItemFields> = {};
    if (!marker.titleDirty && (currentItem.fields.title === undefined || currentItem.fields.title.trim() === "")) {
      fieldPatch.title = suggestion.title;
    }
    if (!marker.categoryChosen) fieldPatch.category = suggestion.category;
    if (Object.keys(fieldPatch).length > 0) {
      dispatchSync({ type: "upsert_item_local", clientItemId: itemClientId, patch: { fields: fieldPatch } });
    }
    setMarker(itemClientId, (m) => ({ ...m, appliedSuggestionPhotoId: coverClientPhotoId }));
    await pushItemToServer(itemClientId);
  }

  // Exposed to screens as a manual "Suggest"/"Try again" action — always
  // `force`d, per `requestSuggestionInternal`'s own comment.
  // `requestSuggestionInternal` closes over refs and stable setters only
  // (see this file's header), so it's safe to omit from the deps array —
  // every call reads `stateRef.current`/`markersRef.current` fresh.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const requestSuggestion = React.useCallback((itemClientId: string) => requestSuggestionInternal(itemClientId, { force: true }), [pushItemToServer]);

  const suggestionForPhoto = React.useCallback((clientPhotoId: string) => suggestions[clientPhotoId] ?? null, [suggestions]);

  // ---------------------------------------------------------------------
  // Apply to selected
  // ---------------------------------------------------------------------
  const applyRoomLabelToSelected = React.useCallback(
    async (itemClientIds: string[], roomLabel: string | null): Promise<void> => {
      for (const itemClientId of itemClientIds) {
        if (stateRef.current.items[itemClientId] === undefined) continue;
        dispatchSync({ type: "upsert_item_local", clientItemId: itemClientId, patch: { roomLabel } });
        await pushItemToServer(itemClientId);
      }
    },
    [pushItemToServer],
  );

  const applyLotLabelToSelected = React.useCallback(
    async (itemClientIds: string[], lotLabel: string | null): Promise<void> => {
      for (const itemClientId of itemClientIds) {
        if (stateRef.current.items[itemClientId] === undefined) continue;
        dispatchSync({ type: "upsert_item_local", clientItemId: itemClientId, patch: { lotLabel } });
        await pushItemToServer(itemClientId);
      }
    },
    [pushItemToServer],
  );

  const previewSharedStoryApplication = React.useCallback((itemClientIds: string[]): SuggestionPreview[] => {
    const shared = stateRef.current.batch.sharedStory?.trim() ?? "";
    const out: SuggestionPreview[] = [];
    for (const itemClientId of itemClientIds) {
      const item = stateRef.current.items[itemClientId];
      if (item === undefined) continue;
      const title = item.fields.title !== undefined && item.fields.title !== "" ? item.fields.title : "Untitled";
      const before = item.fields.story ?? "";
      if (shared === "") {
        out.push({ itemClientId, title, before, after: before, skipped: true, reason: "This batch has no shared story set yet." });
        continue;
      }
      if (before.includes(shared)) {
        out.push({ itemClientId, title, before, after: before, skipped: true, reason: "Already included in this item's story." });
        continue;
      }
      const after = before === "" ? shared : `${before}\n\n${shared}`;
      if (after.length > STORY_MAX) {
        out.push({ itemClientId, title, before, after: before, skipped: true, reason: `Adding it would go past ${STORY_MAX} characters.` });
        continue;
      }
      out.push({ itemClientId, title, before, after, skipped: false, reason: null });
    }
    return out;
  }, []);

  const applySharedStoryToSelected = React.useCallback(
    async (itemClientIds: string[]): Promise<{ applied: number; skipped: number }> => {
      const preview = previewSharedStoryApplication(itemClientIds);
      let applied = 0;
      let skipped = 0;
      for (const row of preview) {
        if (row.skipped) {
          skipped += 1;
          continue;
        }
        dispatchSync({ type: "upsert_item_local", clientItemId: row.itemClientId, patch: { fields: { story: row.after } } });
        await pushItemToServer(row.itemClientId);
        applied += 1;
      }
      return { applied, skipped };
    },
    [previewSharedStoryApplication, pushItemToServer],
  );

  // ---------------------------------------------------------------------
  // Submission
  // ---------------------------------------------------------------------
  const refreshOperations = React.useCallback(async (): Promise<void> => {
    const meta = stateRef.current.batch;
    if (meta.id === null) return;
    const ops = await bulkApi.listBatchOperations(meta.id);
    setOperations(ops);
  }, []);

  const submitItems = React.useCallback(async (itemClientIds: string[], dateOfBirth: string): Promise<BulkResult<BulkOperationSummary>> => {
    const meta = stateRef.current.batch;
    if (meta.id === null) {
      return { ok: false, error: { kind: "unexpected", message: "This batch isn't ready yet.", code: "internal", status: 0 } };
    }
    const items = itemClientIds
      .map((clientItemId) => {
        const item = stateRef.current.items[clientItemId];
        return item !== undefined && item.revision !== null ? { client_item_id: clientItemId, revision: item.revision } : null;
      })
      .filter((row): row is { client_item_id: string; revision: number } => row !== null);
    if (items.length === 0) {
      return { ok: false, error: { kind: "unexpected", message: "Nothing selected is ready to submit.", code: "bad_request", status: 400 } };
    }
    const result = await bulkApi.submitBatch(meta.id, { op_key: makeBulkClientId("submit"), date_of_birth: dateOfBirth, items }, { grantId: grantIdRef.current });
    if (result.ok) setOperations((ops) => [result.data, ...ops]);
    return result;
  }, []);

  return {
    status,
    state,
    grantId,
    setGrantId,
    markers,
    markerFor: (itemClientId) => markerFor(markers, itemClientId),
    isSuggestionStale: (itemClientId) => isSuggestionStale(markers, itemClientId, state.items[itemClientId]?.photoClientIds[0] ?? null),
    suggestionLoading,
    uploadPausedUntil,
    updateBatchMeta,
    cancelBatch: cancelBatchFn,
    addPhotos,
    removePhoto,
    retryPhoto,
    groupAsOneItem,
    groupOnePerPhoto,
    addPhotosToItem,
    removePhotoFromItem,
    setCoverPhoto,
    dissolveItem,
    setItemTitle,
    setItemStory,
    setItemCategory,
    setItemLabels,
    saveItem,
    requestSuggestion,
    suggestionForPhoto,
    applyRoomLabelToSelected,
    applyLotLabelToSelected,
    previewSharedStoryApplication,
    applySharedStoryToSelected,
    operations,
    refreshOperations,
    submitItems,
  };
}

/** Test/UI convenience: drops every local record for a batch and clears its
 * markers — called after a submitted or cancelled batch the giver is done
 * reviewing, per `storage.ts`'s `clearBatch` header. Not called by the hook
 * itself; a screen decides when a batch is truly finished with. */
export async function clearBulkWorkspace(clientBatchKey: string): Promise<void> {
  await clearBatch(getDefaultBulkStorageDriver(), clientBatchKey);
  saveItemMarkers(clientBatchKey, {});
}

export type { BulkDraftPhoto };

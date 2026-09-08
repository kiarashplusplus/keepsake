/**
 * Estate bulk upload: the local draft of one batch, as a pure reducer over a
 * normalized shape — items and photos keyed by their client id, not arrays,
 * because a lookup that's O(1) in `giveDraft.ts`'s five-photo world is O(n)
 * here at 100 items and 300 photos, on every keystroke.
 *
 * Same module split as `features/give/giveDraft.ts`: this file is state
 * logic only — the reducer, the shapes, and pure selectors over them — with
 * no DOM, no `fetch`, no IndexedDB. `storage.ts` is where the IndexedDB side
 * lives (per-item persistence, not one JSON blob — see that file's header
 * for why); `uploadQueue.ts` is what actually drives photo uploads. A future
 * `BulkBatchContext.tsx` stays a thin `useReducer` + effect pair over this
 * module, the same shape `GiveDraftContext.tsx` is over `giveDraft.ts`.
 *
 * `BatchItemState` and `BatchPhotoSummary`'s shape both come straight from
 * `@keepsake/contracts/bulk` rather than being restated — see that module's
 * own header on why a draft item's shape must never carry a second
 * definition of what "ready" means. What contracts/bulk.ts does *not* name
 * is the photo *upload* pipeline's state machine (queued / uploading /
 * complete / retryable failure / permanent failure — the giver's device
 * doing the work), which is this module's to define, in `PhotoUploadState`
 * below. Moderation status is never modeled here at all: once an item has a
 * `listingId`, that listing's own status is the only place it lives — see
 * `BulkDraftItem.listingId`'s comment.
 */
import type { Category } from "@keepsake/contracts/listing";
import type { Country } from "@keepsake/contracts/geo";
import type {
  BatchItemState,
  BatchItemSummary,
  BatchPhotoSummary,
  BatchState,
  BatchSummary,
  DraftItemFields,
} from "@keepsake/contracts/bulk";

// ---------------------------------------------------------------------------
// Photo upload state
// ---------------------------------------------------------------------------

export const PHOTO_UPLOAD_STATES = ["queued", "uploading", "complete", "retryable_failure", "permanent_failure"] as const;
export type PhotoUploadState = (typeof PHOTO_UPLOAD_STATES)[number];

/**
 * One photo in the batch's shared tray, before or after it's grouped into an
 * item (`itemClientId === null` means "not grouped yet" — the tray a giver
 * sorts photos out of, same idea as `UpsertBatchItemInput.photo_client_ids`
 * on the wire).
 *
 * `hasLocalSource`/`needsReselection` are the two halves of this file's
 * eviction story — see `storage.ts`'s header. In short: a `File`/`Blob` is
 * only ever kept resident while a photo hasn't finished uploading
 * (`storage.ts` drops it the moment `status` becomes `"complete"` or
 * `"permanent_failure"`, since neither state will ever read it again), so
 * "bounded" falls out of the state machine rather than a byte-cap alone —
 * the cap in `storage.ts` is defense in depth for a queue that's fallen far
 * behind, not the primary mechanism. `needsReselection` is what a bounded
 * cap, or the browser's own storage pressure, or simply never having
 * uploaded before a device was wiped, all collapse to: this photo needs a
 * human to pick the file again, one photo at a time, rather than losing the
 * batch.
 */
export type BulkDraftPhoto = {
  clientPhotoId: string;
  itemClientId: string | null;
  /** Order within its item (or within the unsorted tray) — mirrors
   * `BatchPhotoSummary.position`; the server is the source of truth once a
   * photo has synced, this is the optimistic local value before then. */
  position: number;
  /** The API's photo id, once the upload has resolved — `null` while
   * queued/uploading/failed. */
  photoId: string | null;
  status: PhotoUploadState;
  /** Stable machine code, same posture as `GiveDraftPhoto.errorCode`: a
   * plain `string`, not a union, so a draft persisted by an older build
   * always rehydrates instead of failing a type check against codes that
   * have since changed. */
  errorCode: string | null;
  error: string | null;
  /** Whether re-running the pipeline on the same source could plausibly
   * succeed — false for a refusal (wrong shape/format) or a state where no
   * source is even held (`needsReselection`), true for a timeout or a 5xx.
   * See `uploadQueue.ts`'s `classifyPhotoUploadFailure`, which is the only
   * place that sets this. */
  canRetry: boolean;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  /** This session's `URL.createObjectURL` preview, the first rung of
   * `features/bulk/photoSource.ts`'s ladder — instant, no request, and
   * never persisted (a blob URL dies with the document that minted it, the
   * same reason `giveDraft.ts`'s `deserializeGiveDraft` nulls its
   * equivalent field on every rehydrate). `storage.ts` never sees this
   * field; `null` immediately after any reload. */
  localPreviewUrl: string | null;
  /** `/i/:id/thumb`, once the server has assigned one — the ladder's second
   * rung, after this session's object URL and before the blurhash
   * placeholder. */
  urlThumb: string | null;
  /** True while `storage.ts` still holds this photo's source bytes
   * (IndexedDB, or this session's in-memory queue before the first
   * persist). Always false once `status` is `"complete"` — the source is
   * never needed again once the server has the photo. */
  hasLocalSource: boolean;
  /** True when this photo still needs uploading but no local source is
   * available for it — an evicted or never-persisted file. The give-flow
   * equivalent (`GiveDraftPhoto`) doesn't need this: five photos in one
   * sitting fit in a session; 300 across several sittings on a phone do
   * not. Drives the screens' "select this photo again" affordance, not a
   * retry button — retrying with no source would just fail identically. */
  needsReselection: boolean;
  createdAt: number;
  updatedAt: number;
};

// ---------------------------------------------------------------------------
// Draft item
// ---------------------------------------------------------------------------

export type BulkDraftItem = {
  clientItemId: string;
  /** The server's id, once this item has been saved at least once. */
  id: string | null;
  fields: DraftItemFields;
  roomLabel: string | null;
  lotLabel: string | null;
  /** Ordered, first is the cover — mirrors `UpsertBatchItemInput.photo_client_ids`. */
  photoClientIds: string[];
  state: BatchItemState;
  /** `null` until the first successful `PUT` — nothing to run optimistic
   * concurrency against before then, matching `UpsertBatchItemInput`'s own
   * "omitted `expected_revision` only when creating" rule. */
  revision: number | null;
  /** The listing this item became. Once set, `listingId` is where its
   * moderation status lives (`GET /api/me/listings`, like any other
   * listing) — this module never mirrors that status itself, per the file
   * header. */
  listingId: string | null;
  /** Server-computed, per `BatchItemSummary.ready`'s own comment: never
   * derived locally, so the "N ready" line and the submission can't
   * disagree about what ready means. `null` until this item has synced at
   * least once. */
  ready: boolean | null;
  blockedReason: string | null;
  /** True when a local edit (fields, labels, or photo grouping) hasn't yet
   * been confirmed by a successful `PUT` — the caller's cue to queue a
   * save. This module never issues the `PUT` itself; that's `src/api/
   * bulk.ts`'s `upsertBatchItem`, called from wherever edits are made. */
  dirty: boolean;
  createdAt: number;
  updatedAt: number;
};

// ---------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------

export type BulkBatchMeta = {
  /** The key this whole draft is addressed by, locally and on the wire
   * (`CreateBatchInput.client_batch_key`) — assigned once, at creation, and
   * never reused; `storage.ts` keys every IndexedDB record off it, batch or
   * server id may still be `null` at that point. */
  clientBatchKey: string;
  /** The server's id, once `POST /batches` (or a retry that resolved to an
   * existing row) has returned one. */
  id: string | null;
  name: string;
  country: Country;
  postalCode: string;
  placeName: string | null;
  admin1: string | null;
  sharedStory: string | null;
  state: BatchState;
  /** `null` until the first successful create/update. */
  revision: number | null;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type BulkBatchState = {
  batch: BulkBatchMeta;
  items: Record<string, BulkDraftItem>;
  /** Stable display order for `items` — insertion order, not resorted on
   * every patch, so a giver reordering nothing doesn't watch their list
   * jump. */
  itemOrder: string[];
  photos: Record<string, BulkDraftPhoto>;
};

export function makeBulkBatchMeta(
  clientBatchKey: string,
  seed: Pick<BulkBatchMeta, "name" | "country" | "postalCode">,
  now: number = Date.now(),
): BulkBatchMeta {
  return {
    clientBatchKey,
    id: null,
    name: seed.name,
    country: seed.country,
    postalCode: seed.postalCode,
    placeName: null,
    admin1: null,
    sharedStory: null,
    state: "draft",
    revision: null,
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function emptyBulkBatchState(meta: BulkBatchMeta): BulkBatchState {
  return { batch: meta, items: {}, itemOrder: [], photos: {} };
}

export function makeBulkDraftItem(clientItemId: string, now: number = Date.now()): BulkDraftItem {
  return {
    clientItemId,
    id: null,
    fields: {},
    roomLabel: null,
    lotLabel: null,
    photoClientIds: [],
    state: "editing",
    revision: null,
    listingId: null,
    ready: null,
    blockedReason: null,
    dirty: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function makeBulkDraftPhoto(
  clientPhotoId: string,
  overrides: Partial<Pick<BulkDraftPhoto, "itemClientId" | "position" | "localPreviewUrl">> = {},
  now: number = Date.now(),
): BulkDraftPhoto {
  return {
    clientPhotoId,
    itemClientId: overrides.itemClientId ?? null,
    position: overrides.position ?? 0,
    photoId: null,
    status: "queued",
    errorCode: null,
    error: null,
    canRetry: false,
    width: null,
    height: null,
    blurhash: null,
    localPreviewUrl: overrides.localPreviewUrl ?? null,
    urlThumb: null,
    hasLocalSource: true,
    needsReselection: false,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Clears everything about a persisted photo that cannot have survived a
 * reload — the local blob-URL preview (dies with the document that minted
 * it, same as `giveDraft.ts`'s `deserializeGiveDraft` on `objectUrl`), and
 * an in-flight `"uploading"` status, whose pipeline died with the tab that
 * started it and would otherwise sit forever with no queue driving it back
 * to `"queued"`. Pure, so `storage.ts`'s `loadBatchState` is the only
 * caller that needs to know this rule exists, and this file's own tests can
 * cover it without touching IndexedDB.
 */
export function rehydratePhoto(photo: BulkDraftPhoto): BulkDraftPhoto {
  return {
    ...photo,
    localPreviewUrl: null,
    ...(photo.status === "uploading" ? { status: "queued" as const } : {}),
  };
}

export function rehydrateBulkBatchState(state: BulkBatchState): BulkBatchState {
  const photos: Record<string, BulkDraftPhoto> = {};
  for (const [clientPhotoId, photo] of Object.entries(state.photos)) {
    photos[clientPhotoId] = rehydratePhoto(photo);
  }
  return { ...state, photos };
}

// ---------------------------------------------------------------------------
// Server sync: translating BatchSummary/BatchItemSummary/BatchPhotoSummary
// ---------------------------------------------------------------------------

export function batchMetaFromSummary(clientBatchKey: string, summary: BatchSummary): BulkBatchMeta {
  return {
    clientBatchKey,
    id: summary.id,
    name: summary.name,
    country: summary.country,
    postalCode: summary.postal_code,
    placeName: summary.place_name,
    admin1: summary.admin1,
    sharedStory: summary.shared_story,
    state: summary.state,
    revision: summary.revision,
    expiresAt: summary.expires_at,
    createdAt: summary.created_at,
    updatedAt: summary.updated_at,
  };
}

export function itemFromSummary(summary: BatchItemSummary, now: number = Date.now()): BulkDraftItem {
  return {
    clientItemId: summary.client_item_id,
    id: summary.id,
    fields: {
      ...(summary.title !== null ? { title: summary.title } : {}),
      ...(summary.story !== null ? { story: summary.story } : {}),
      ...(summary.category !== null ? { category: summary.category as Category } : {}),
      aspects: summary.aspects,
    },
    roomLabel: summary.room_label,
    lotLabel: summary.lot_label,
    photoClientIds: summary.photo_client_ids,
    state: summary.state,
    revision: summary.revision,
    listingId: summary.listing_id,
    ready: summary.ready,
    blockedReason: summary.blocked_reason,
    dirty: false,
    createdAt: summary.created_at,
    updatedAt: now,
  };
}

/** Merges a server photo response onto whatever local record exists (there
 * always should be one — a photo is only ever synced after `add_photo`
 * added it locally — but falls back to a fresh one so a hydration ordering
 * bug degrades to "this photo showed up" rather than a thrown error). */
export function photoFromSummary(summary: BatchPhotoSummary, previous: BulkDraftPhoto | null, now: number = Date.now()): BulkDraftPhoto {
  const base = previous ?? makeBulkDraftPhoto(summary.client_photo_id, {}, now);
  return {
    ...base,
    clientPhotoId: summary.client_photo_id,
    itemClientId: summary.item_client_id,
    position: summary.position,
    photoId: summary.photo_id,
    status: "complete",
    errorCode: null,
    error: null,
    canRetry: false,
    urlThumb: summary.url_thumb,
    hasLocalSource: false,
    needsReselection: false,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Actions and reducer
// ---------------------------------------------------------------------------

export type BulkBatchAction =
  | { type: "hydrate"; state: BulkBatchState }
  | { type: "reset"; meta: BulkBatchMeta }
  | { type: "patch_batch_meta"; patch: Partial<BulkBatchMeta> }
  | { type: "batch_synced"; summary: BatchSummary }
  | { type: "upsert_item_local"; clientItemId: string; patch: Partial<Pick<BulkDraftItem, "fields" | "roomLabel" | "lotLabel" | "photoClientIds">> }
  | { type: "item_synced"; summary: BatchItemSummary }
  | { type: "item_sync_failed"; clientItemId: string }
  | { type: "remove_item"; clientItemId: string }
  | { type: "add_photo"; photo: BulkDraftPhoto }
  | { type: "update_photo"; clientPhotoId: string; patch: Partial<BulkDraftPhoto> }
  | { type: "photo_synced"; summary: BatchPhotoSummary }
  | { type: "remove_photo"; clientPhotoId: string };

export function bulkBatchReducer(state: BulkBatchState, action: BulkBatchAction): BulkBatchState {
  switch (action.type) {
    case "hydrate":
      return action.state;

    case "reset":
      return emptyBulkBatchState(action.meta);

    case "patch_batch_meta":
      return { ...state, batch: { ...state.batch, ...action.patch, updatedAt: Date.now() } };

    case "batch_synced":
      return { ...state, batch: batchMetaFromSummary(state.batch.clientBatchKey, action.summary) };

    case "upsert_item_local": {
      const existing = state.items[action.clientItemId] ?? makeBulkDraftItem(action.clientItemId);
      const item: BulkDraftItem = {
        ...existing,
        ...action.patch,
        fields: action.patch.fields !== undefined ? { ...existing.fields, ...action.patch.fields } : existing.fields,
        dirty: true,
        updatedAt: Date.now(),
      };
      const itemOrder = state.items[action.clientItemId] ? state.itemOrder : [...state.itemOrder, action.clientItemId];
      return { ...state, items: { ...state.items, [action.clientItemId]: item }, itemOrder };
    }

    case "item_synced": {
      const clientItemId = action.summary.client_item_id;
      const item = itemFromSummary(action.summary);
      const itemOrder = state.items[clientItemId] ? state.itemOrder : [...state.itemOrder, clientItemId];
      return { ...state, items: { ...state.items, [clientItemId]: item }, itemOrder };
    }

    case "item_sync_failed": {
      const existing = state.items[action.clientItemId];
      if (!existing) return state;
      return { ...state, items: { ...state.items, [action.clientItemId]: { ...existing, state: "failed" } } };
    }

    case "remove_item": {
      if (!state.items[action.clientItemId]) return state;
      const items = { ...state.items };
      delete items[action.clientItemId];
      return { ...state, items, itemOrder: state.itemOrder.filter((id) => id !== action.clientItemId) };
    }

    case "add_photo":
      return { ...state, photos: { ...state.photos, [action.photo.clientPhotoId]: action.photo } };

    case "update_photo": {
      const existing = state.photos[action.clientPhotoId];
      if (!existing) return state;
      return {
        ...state,
        photos: { ...state.photos, [action.clientPhotoId]: { ...existing, ...action.patch, updatedAt: Date.now() } },
      };
    }

    case "photo_synced": {
      const clientPhotoId = action.summary.client_photo_id;
      const previous = state.photos[clientPhotoId] ?? null;
      return { ...state, photos: { ...state.photos, [clientPhotoId]: photoFromSummary(action.summary, previous) } };
    }

    case "remove_photo": {
      if (!state.photos[action.clientPhotoId]) return state;
      const photos = { ...state.photos };
      delete photos[action.clientPhotoId];
      return { ...state, photos };
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export function listItems(state: BulkBatchState): BulkDraftItem[] {
  return state.itemOrder.map((id) => state.items[id]).filter((item): item is BulkDraftItem => item !== undefined);
}

export function listPhotosForItem(state: BulkBatchState, clientItemId: string): BulkDraftPhoto[] {
  const item = state.items[clientItemId];
  if (!item) return [];
  return item.photoClientIds.map((id) => state.photos[id]).filter((photo): photo is BulkDraftPhoto => photo !== undefined);
}

/** The tray: photos not yet grouped into any item. */
export function unassignedPhotos(state: BulkBatchState): BulkDraftPhoto[] {
  return Object.values(state.photos)
    .filter((photo) => photo.itemClientId === null)
    .sort((a, b) => a.position - b.position);
}

/** Every photo still owed an upload attempt — `uploadQueue.ts`'s resume seed. */
export function pendingUploadPhotos(state: BulkBatchState): BulkDraftPhoto[] {
  return Object.values(state.photos).filter((photo) => photo.status === "queued" || photo.status === "uploading");
}

export function readyItemCount(state: BulkBatchState): number {
  return listItems(state).filter((item) => item.ready === true).length;
}

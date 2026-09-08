/**
 * Per-item IndexedDB persistence for one bulk batch draft.
 *
 * `giveDraftReducer`'s whole state mirrors into one `sessionStorage` key on
 * every dispatch (`GiveDraftContext.tsx`), which is fine at five photos and
 * wrong at a hundred items and three hundred: `JSON.stringify`-ing the whole
 * draft on every keystroke is a multi-megabyte string, rewritten in full,
 * against an origin-wide quota of a few MB (`sessionStorage`/`localStorage`
 * share one small budget; IndexedDB's is the browser's real per-origin disk
 * allowance). So this module writes **one record per item, one per photo**,
 * each independently — editing item 47's story writes one small row, not
 * the other 99 items and 300 photos along with it. `batchStore.ts` stays
 * the pure, dependency-free reducer; this file is the only thing in
 * `features/bulk/` that touches a browser storage API, and every function
 * here takes a `BulkStorageDriver` so the persistence *logic* — what gets
 * written where, the eviction rule below — is unit-testable against
 * `createMemoryDriver()` without a real IndexedDB (jsdom, this repo's test
 * environment, doesn't implement one).
 *
 * ## Bounded local file data
 *
 * A photo's source `Blob` is the one thing here that can be large — up to
 * `MAX_UPLOAD_BYTES` (`lib/images/prepareUpload.ts`) per photo, times up to
 * `MAX_BATCH_PHOTOS` (300, `@keepsake/contracts/bulk`) if a giver queued
 * everything before any of it uploaded. Two things keep that bounded:
 *
 * 1. **Structural**: a source is only ever kept once a photo still needs
 *    uploading. `dropPhotoSource` below is called (by `uploadQueue.ts`) the
 *    moment a photo reaches `"complete"` or `"permanent_failure"` — neither
 *    state will ever read the bytes again, so nothing is holding them "just
 *    in case". A batch that finishes uploading holds zero resident source
 *    bytes no matter how many photos it had.
 * 2. **A hard cap** (`MAX_RESIDENT_SOURCE_BYTES`) as defense against a queue
 *    that's fallen far behind the giver's picking — `savePhotoSource`
 *    refuses to store a *new* source once the batch's already-resident
 *    total would exceed it, rather than silently growing without limit.
 *
 * Neither mechanism *prevents* the browser from evicting a still-needed
 * source out from under this batch — Safari does this under storage
 * pressure with no callback to catch — so `getPhotoSource` returning `null`
 * for a photo whose metadata says `hasLocalSource: true` is a real,
 * expected case, not a bug: the caller (`uploadQueue.ts`) reconciles it into
 * `needsReselection: true` rather than crashing or losing the item. That is
 * the recoverability this module promises: **the photo**, not the batch.
 *
 * This module claims nothing about offline support or background upload —
 * writes here only ever happen while the tab that made them is open, and
 * nothing here schedules work for when it isn't.
 */
import { rehydrateBulkBatchState, type BulkBatchMeta, type BulkBatchState, type BulkDraftItem, type BulkDraftPhoto } from "@/features/bulk/batchStore";

const DB_NAME = "keepsake.bulk.v1";
const DB_VERSION = 1;

export const BATCHES_STORE = "batches";
export const ITEMS_STORE = "items";
export const PHOTOS_STORE = "photos";
export const PHOTO_BLOBS_STORE = "photoBlobs";

type StoreName = typeof BATCHES_STORE | typeof ITEMS_STORE | typeof PHOTOS_STORE | typeof PHOTO_BLOBS_STORE;

/**
 * The storage backend this module actually needs: per-store get/put/delete
 * by key, plus two batch-scoped bulk reads/deletes. Deliberately narrower
 * than a generic IndexedDB wrapper — every operation this file performs is
 * one of these six.
 */
export interface BulkStorageDriver {
  put(store: StoreName, key: string, value: unknown): Promise<void>;
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  delete(store: StoreName, key: string): Promise<void>;
  getAllByBatch<T>(store: StoreName, batchKey: string): Promise<T[]>;
  deleteAllByBatch(store: StoreName, batchKey: string): Promise<void>;
  /** Every batch key with at least one record in `BATCHES_STORE` — how a
   * screen finds what's resumable without knowing the key up front. */
  listBatchKeys(): Promise<string[]>;
}

function recordKey(batchKey: string, id: string): string {
  return `${batchKey}:${id}`;
}

// ---------------------------------------------------------------------------
// IndexedDB-backed driver
// ---------------------------------------------------------------------------

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function promisifyTx(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BATCHES_STORE)) db.createObjectStore(BATCHES_STORE);
      for (const store of [ITEMS_STORE, PHOTOS_STORE, PHOTO_BLOBS_STORE]) {
        if (!db.objectStoreNames.contains(store)) {
          const os = db.createObjectStore(store);
          os.createIndex("by_batch", "__batchKey", { unique: false });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Couldn't open the bulk upload database."));
  });
  return dbPromise;
}

/** True when this runtime has a usable `indexedDB` — false in a test's
 * jsdom environment and in the rare browser that disables it entirely
 * (private-mode Safari, historically). Callers use this to fall back to
 * `createMemoryDriver()` rather than throwing on every write. */
export function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

/** Wraps every store's key in `{__batchKey, ...}` so the `by_batch` index
 * can find it — invisible to callers, who only ever get back what they put
 * in via `get`/`getAllByBatch`. */
function withBatchKey(store: StoreName, batchKey: string, value: unknown): unknown {
  if (store === BATCHES_STORE) return value;
  return { __batchKey: batchKey, value };
}

function unwrap<T>(store: StoreName, raw: unknown): T {
  if (store === BATCHES_STORE) return raw as T;
  return (raw as { value: T }).value;
}

export function createIndexedDbDriver(): BulkStorageDriver {
  return {
    async put(store, key, value) {
      const db = await openDb();
      const tx = db.transaction(store, "readwrite");
      const batchKey = store === BATCHES_STORE ? key : key.split(":")[0]!;
      tx.objectStore(store).put(withBatchKey(store, batchKey, value), key);
      await promisifyTx(tx);
    },
    async get<T>(store: StoreName, key: string) {
      const db = await openDb();
      const tx = db.transaction(store, "readonly");
      const raw = await promisifyRequest(tx.objectStore(store).get(key));
      return raw === undefined ? undefined : unwrap<T>(store, raw);
    },
    async delete(store, key) {
      const db = await openDb();
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).delete(key);
      await promisifyTx(tx);
    },
    async getAllByBatch<T>(store: StoreName, batchKey: string) {
      if (store === BATCHES_STORE) throw new Error("getAllByBatch is not meaningful on the batches store");
      const db = await openDb();
      const tx = db.transaction(store, "readonly");
      const index = tx.objectStore(store).index("by_batch");
      const raw = await promisifyRequest(index.getAll(IDBKeyRange.only(batchKey)));
      return raw.map((r) => unwrap<T>(store, r));
    },
    async deleteAllByBatch(store, batchKey) {
      if (store === BATCHES_STORE) {
        const db = await openDb();
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).delete(batchKey);
        await promisifyTx(tx);
        return;
      }
      const db = await openDb();
      const tx = db.transaction(store, "readwrite");
      const index = tx.objectStore(store).index("by_batch");
      const cursorReq = index.openKeyCursor(IDBKeyRange.only(batchKey));
      await new Promise<void>((resolve, reject) => {
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            tx.objectStore(store).delete(cursor.primaryKey);
            cursor.continue();
          } else {
            resolve();
          }
        };
        cursorReq.onerror = () => reject(cursorReq.error ?? new Error("Couldn't clear this batch's records."));
      });
      await promisifyTx(tx);
    },
    async listBatchKeys() {
      const db = await openDb();
      const tx = db.transaction(BATCHES_STORE, "readonly");
      const keys = await promisifyRequest(tx.objectStore(BATCHES_STORE).getAllKeys());
      return keys.map(String);
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory driver — the test double, and a same-tab-only fallback for a
// runtime with no IndexedDB at all (nothing here claims that fallback
// survives a reload; it exists so a write doesn't throw, not so it persists)
// ---------------------------------------------------------------------------

export function createMemoryDriver(): BulkStorageDriver {
  const stores: Record<StoreName, Map<string, unknown>> = {
    [BATCHES_STORE]: new Map(),
    [ITEMS_STORE]: new Map(),
    [PHOTOS_STORE]: new Map(),
    [PHOTO_BLOBS_STORE]: new Map(),
  };

  function batchKeyOf(key: string): string {
    return key.split(":")[0]!;
  }

  return {
    async put(store, key, value) {
      stores[store].set(key, value);
    },
    async get<T>(store: StoreName, key: string) {
      return stores[store].get(key) as T | undefined;
    },
    async delete(store, key) {
      stores[store].delete(key);
    },
    async getAllByBatch<T>(store: StoreName, batchKey: string) {
      const out: T[] = [];
      for (const [key, value] of stores[store]) {
        if (batchKeyOf(key) === batchKey) out.push(value as T);
      }
      return out;
    },
    async deleteAllByBatch(store, batchKey) {
      for (const key of [...stores[store].keys()]) {
        if (store === BATCHES_STORE ? key === batchKey : batchKeyOf(key) === batchKey) stores[store].delete(key);
      }
    },
    async listBatchKeys() {
      return [...stores[BATCHES_STORE].keys()];
    },
  };
}

let defaultDriver: BulkStorageDriver | null = null;

/** The driver a real screen should use: IndexedDB when available, an
 * in-memory (non-persistent) fallback otherwise, so a browser without one —
 * rather than the whole feature — is what degrades. */
export function getDefaultBulkStorageDriver(): BulkStorageDriver {
  defaultDriver ??= isIndexedDbAvailable() ? createIndexedDbDriver() : createMemoryDriver();
  return defaultDriver;
}

// ---------------------------------------------------------------------------
// High-level per-item / per-photo persistence
// ---------------------------------------------------------------------------

/** Defense-in-depth cap on resident, not-yet-uploaded source bytes for one
 * batch — see this file's header. A mutable field on an exported object
 * rather than a `let` binding, so a caller that wants to tighten it (a
 * slower device, a lower-memory browser) can, without this module needing a
 * setter for every tunable it ever grows. */
export const bulkStorageConfig = { maxResidentSourceBytes: 150 * 1024 * 1024 };

export async function saveBatchMeta(driver: BulkStorageDriver, meta: BulkBatchMeta): Promise<void> {
  await driver.put(BATCHES_STORE, meta.clientBatchKey, meta);
}

export async function saveItem(driver: BulkStorageDriver, batchKey: string, item: BulkDraftItem): Promise<void> {
  await driver.put(ITEMS_STORE, recordKey(batchKey, item.clientItemId), item);
}

export async function deleteItemRecord(driver: BulkStorageDriver, batchKey: string, clientItemId: string): Promise<void> {
  await driver.delete(ITEMS_STORE, recordKey(batchKey, clientItemId));
}

/** Sums the actual resident blobs for a batch — `Blob.size` is metadata on
 * the object itself, so listing every blob in `PHOTO_BLOBS_STORE` for one
 * batch to total it never reads a single byte of image data. This is also
 * why metadata (`PHOTOS_STORE`) and source bytes (`PHOTO_BLOBS_STORE`) are
 * two separate stores rather than one record with a `Blob` field:
 * `loadBatchState` below reads only the metadata store, so rehydrating a
 * 300-photo batch on load never touches a blob either. */
async function residentSourceBytes(driver: BulkStorageDriver, batchKey: string): Promise<number> {
  const blobs = await driver.getAllByBatch<Blob>(PHOTO_BLOBS_STORE, batchKey);
  return blobs.reduce((total, blob) => total + blob.size, 0);
}

export async function savePhotoMeta(driver: BulkStorageDriver, batchKey: string, photo: BulkDraftPhoto): Promise<void> {
  await driver.put(PHOTOS_STORE, recordKey(batchKey, photo.clientPhotoId), photo);
}

export type SavePhotoSourceOutcome = { stored: boolean };

/**
 * Stores a photo's source `Blob`, unless doing so would push this batch's
 * resident total over `bulkStorageConfig.maxResidentSourceBytes`, or the
 * browser itself throws a quota error mid-write (caught here, not left to
 * crash the caller). Either refusal returns `{stored:false}` — the caller
 * (`uploadQueue.ts`) is expected to reflect that back onto the photo's
 * *metadata* (`needsReselection: true`, `hasLocalSource: false`, via
 * `savePhotoMeta` and the matching `batchStore.ts` `update_photo`), which is
 * what actually makes the loss visible and recoverable rather than quietly
 * missing the next time something asks for it.
 */
export async function savePhotoSource(
  driver: BulkStorageDriver,
  batchKey: string,
  clientPhotoId: string,
  sourceBlob: Blob,
): Promise<SavePhotoSourceOutcome> {
  const key = recordKey(batchKey, clientPhotoId);
  const existing = await driver.get<Blob>(PHOTO_BLOBS_STORE, key);
  const currentTotal = await residentSourceBytes(driver, batchKey);
  const projectedTotal = currentTotal - (existing?.size ?? 0) + sourceBlob.size;

  if (projectedTotal > bulkStorageConfig.maxResidentSourceBytes) {
    return { stored: false };
  }

  try {
    await driver.put(PHOTO_BLOBS_STORE, key, sourceBlob);
    return { stored: true };
  } catch {
    // A real quota error from the browser, not our own cap — same outcome.
    await driver.delete(PHOTO_BLOBS_STORE, key).catch(() => {});
    return { stored: false };
  }
}

/** Convenience wrapper over `savePhotoMeta` + `savePhotoSource` for the
 * common "just picked this file" case — writes the metadata unconditionally
 * and reconciles `hasLocalSource`/`needsReselection` onto it based on
 * whether the source actually got stored, so a caller doesn't have to
 * repeat that bookkeeping at every call site. `uploadQueue.ts` calls the two
 * lower-level functions directly instead, since it doesn't hold a full
 * `BulkDraftPhoto` to write. */
export async function savePhoto(driver: BulkStorageDriver, batchKey: string, photo: BulkDraftPhoto, sourceBlob: Blob | null): Promise<SavePhotoSourceOutcome> {
  if (sourceBlob === null) {
    await savePhotoMeta(driver, batchKey, { ...photo, hasLocalSource: false });
    await driver.delete(PHOTO_BLOBS_STORE, recordKey(batchKey, photo.clientPhotoId));
    return { stored: true };
  }
  const outcome = await savePhotoSource(driver, batchKey, photo.clientPhotoId, sourceBlob);
  await savePhotoMeta(driver, batchKey, {
    ...photo,
    hasLocalSource: outcome.stored,
    needsReselection: photo.needsReselection && outcome.stored ? false : !outcome.stored,
  });
  return outcome;
}

/** Drops a photo's source bytes without touching its metadata — call once a
 * photo reaches `"complete"` or `"permanent_failure"`, per this file's
 * header. Leaves stored metadata's `hasLocalSource` untouched; it's the
 * caller's job (`uploadQueue.ts`) to also dispatch the matching
 * `update_photo`/`savePhotoMeta` so the reducer's and storage's copies both
 * agree the source is gone. */
export async function dropPhotoSource(driver: BulkStorageDriver, batchKey: string, clientPhotoId: string): Promise<void> {
  await driver.delete(PHOTO_BLOBS_STORE, recordKey(batchKey, clientPhotoId));
}

export async function getPhotoSource(driver: BulkStorageDriver, batchKey: string, clientPhotoId: string): Promise<Blob | null> {
  const blob = await driver.get<Blob>(PHOTO_BLOBS_STORE, recordKey(batchKey, clientPhotoId));
  return blob ?? null;
}

export async function deletePhotoRecord(driver: BulkStorageDriver, batchKey: string, clientPhotoId: string): Promise<void> {
  const key = recordKey(batchKey, clientPhotoId);
  await driver.delete(PHOTOS_STORE, key);
  await driver.delete(PHOTO_BLOBS_STORE, key);
}

/** Reads back everything persisted for one batch — metadata only, no
 * blobs — and reconstructs a `BulkBatchState` `batchStore.ts` can `hydrate`
 * straight into a reducer. Returns `null` when nothing's been persisted for
 * this key at all (a fresh batch, or one this device never touched). */
export async function loadBatchState(driver: BulkStorageDriver, batchKey: string): Promise<BulkBatchState | null> {
  const meta = await driver.get<BulkBatchMeta>(BATCHES_STORE, batchKey);
  if (!meta) return null;

  const items = await driver.getAllByBatch<BulkDraftItem>(ITEMS_STORE, batchKey);
  const photoList = await driver.getAllByBatch<BulkDraftPhoto>(PHOTOS_STORE, batchKey);

  const itemsById: Record<string, BulkDraftItem> = {};
  const itemOrder: string[] = [];
  for (const item of items.sort((a, b) => a.createdAt - b.createdAt)) {
    itemsById[item.clientItemId] = item;
    itemOrder.push(item.clientItemId);
  }

  const photos: Record<string, BulkDraftPhoto> = {};
  for (const photo of photoList) {
    photos[photo.clientPhotoId] = photo;
  }

  return rehydrateBulkBatchState({ batch: meta, items: itemsById, itemOrder, photos });
}

export async function listPersistedBatchKeys(driver: BulkStorageDriver): Promise<string[]> {
  return driver.listBatchKeys();
}

/** Removes every trace of one batch — its meta, every item, every photo
 * (metadata and any still-resident source). Call on a cancelled or fully
 * submitted batch a giver is done reviewing, never before then: this is
 * what makes a mid-draft browser crash unrecoverable, so it must only run
 * on a batch nothing still needs. */
export async function clearBatch(driver: BulkStorageDriver, batchKey: string): Promise<void> {
  await driver.deleteAllByBatch(BATCHES_STORE, batchKey);
  await driver.deleteAllByBatch(ITEMS_STORE, batchKey);
  await driver.deleteAllByBatch(PHOTOS_STORE, batchKey);
  await driver.deleteAllByBatch(PHOTO_BLOBS_STORE, batchKey);
}

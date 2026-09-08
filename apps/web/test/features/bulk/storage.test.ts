import { makeBulkBatchMeta, makeBulkDraftItem, makeBulkDraftPhoto } from "@/features/bulk/batchStore";
import {
  bulkStorageConfig,
  clearBatch,
  createMemoryDriver,
  deletePhotoRecord,
  dropPhotoSource,
  getPhotoSource,
  listPersistedBatchKeys,
  loadBatchState,
  saveBatchMeta,
  savePhotoMeta,
  savePhotoSource,
  saveItem,
} from "@/features/bulk/storage";

function blob(bytes: number): Blob {
  return new Blob([new Uint8Array(bytes)]);
}

describe("storage: per-item persistence", () => {
  it("loadBatchState returns null for a batch nothing was ever saved for", async () => {
    const driver = createMemoryDriver();
    await expect(loadBatchState(driver, "no-such-batch")).resolves.toBeNull();
  });

  it("round-trips batch meta, items, and photo metadata independently", async () => {
    const driver = createMemoryDriver();
    const meta = makeBulkBatchMeta("batch-1", { name: "Estate", country: "US", postalCode: "94110" }, 1000);
    await saveBatchMeta(driver, meta);

    const item = makeBulkDraftItem("item-a", 1000);
    await saveItem(driver, "batch-1", item);

    const photo = makeBulkDraftPhoto("photo-a", {}, 1000);
    await savePhotoMeta(driver, "batch-1", photo);

    const state = await loadBatchState(driver, "batch-1");
    expect(state?.batch.name).toBe("Estate");
    expect(state?.itemOrder).toEqual(["item-a"]);
    expect(state?.items["item-a"]).toEqual(item);
    expect(state?.photos["photo-a"]).toMatchObject({ clientPhotoId: "photo-a" });
  });

  it("editing one item writes only that item's record — a second batch's records are untouched", async () => {
    const driver = createMemoryDriver();
    await saveBatchMeta(driver, makeBulkBatchMeta("batch-1", { name: "A", country: "US", postalCode: "94110" }));
    await saveBatchMeta(driver, makeBulkBatchMeta("batch-2", { name: "B", country: "US", postalCode: "94110" }));
    await saveItem(driver, "batch-1", makeBulkDraftItem("item-a"));
    await saveItem(driver, "batch-2", makeBulkDraftItem("item-z"));

    const batch1 = await loadBatchState(driver, "batch-1");
    const batch2 = await loadBatchState(driver, "batch-2");
    expect(batch1?.itemOrder).toEqual(["item-a"]);
    expect(batch2?.itemOrder).toEqual(["item-z"]);
  });

  it("loadBatchState rehydrates: clears local preview URLs and resets an interrupted upload to queued", async () => {
    const driver = createMemoryDriver();
    await saveBatchMeta(driver, makeBulkBatchMeta("batch-1", { name: "A", country: "US", postalCode: "94110" }));
    await savePhotoMeta(driver, "batch-1", {
      ...makeBulkDraftPhoto("photo-a", { localPreviewUrl: "blob:dead" }),
      status: "uploading",
    });

    const state = await loadBatchState(driver, "batch-1");
    expect(state?.photos["photo-a"]).toMatchObject({ localPreviewUrl: null, status: "queued" });
  });

  it("listPersistedBatchKeys reports every batch with a meta record", async () => {
    const driver = createMemoryDriver();
    await saveBatchMeta(driver, makeBulkBatchMeta("batch-1", { name: "A", country: "US", postalCode: "94110" }));
    await saveBatchMeta(driver, makeBulkBatchMeta("batch-2", { name: "B", country: "US", postalCode: "94110" }));
    expect((await listPersistedBatchKeys(driver)).sort()).toEqual(["batch-1", "batch-2"]);
  });

  it("clearBatch removes meta, items, photo metadata, and any resident source for that batch only", async () => {
    const driver = createMemoryDriver();
    await saveBatchMeta(driver, makeBulkBatchMeta("batch-1", { name: "A", country: "US", postalCode: "94110" }));
    await saveBatchMeta(driver, makeBulkBatchMeta("batch-2", { name: "B", country: "US", postalCode: "94110" }));
    await saveItem(driver, "batch-1", makeBulkDraftItem("item-a"));
    await savePhotoMeta(driver, "batch-1", makeBulkDraftPhoto("photo-a"));
    await savePhotoSource(driver, "batch-1", "photo-a", blob(10));

    await clearBatch(driver, "batch-1");

    expect(await loadBatchState(driver, "batch-1")).toBeNull();
    expect(await getPhotoSource(driver, "batch-1", "photo-a")).toBeNull();
    expect(await loadBatchState(driver, "batch-2")).not.toBeNull();
  });
});

describe("storage: bounded local file data", () => {
  const originalCap = bulkStorageConfig.maxResidentSourceBytes;
  afterEach(() => {
    bulkStorageConfig.maxResidentSourceBytes = originalCap;
  });

  it("getPhotoSource returns null once dropPhotoSource has run — the 'no longer needed' path", async () => {
    const driver = createMemoryDriver();
    await savePhotoSource(driver, "batch-1", "photo-a", blob(1000));
    expect(await getPhotoSource(driver, "batch-1", "photo-a")).not.toBeNull();

    await dropPhotoSource(driver, "batch-1", "photo-a");
    expect(await getPhotoSource(driver, "batch-1", "photo-a")).toBeNull();
  });

  it("deletePhotoRecord removes both metadata and any resident source", async () => {
    const driver = createMemoryDriver();
    await savePhotoMeta(driver, "batch-1", makeBulkDraftPhoto("photo-a"));
    await savePhotoSource(driver, "batch-1", "photo-a", blob(1000));

    await deletePhotoRecord(driver, "batch-1", "photo-a");

    const state = await (async () => {
      await saveBatchMeta(driver, makeBulkBatchMeta("batch-1", { name: "A", country: "US", postalCode: "94110" }));
      return loadBatchState(driver, "batch-1");
    })();
    expect(state?.photos["photo-a"]).toBeUndefined();
    expect(await getPhotoSource(driver, "batch-1", "photo-a")).toBeNull();
  });

  it("refuses a new source once the batch's resident total would exceed the cap, without touching existing sources", async () => {
    const driver = createMemoryDriver();
    bulkStorageConfig.maxResidentSourceBytes = 1500;

    const first = await savePhotoSource(driver, "batch-1", "photo-a", blob(1000));
    expect(first.stored).toBe(true);

    const second = await savePhotoSource(driver, "batch-1", "photo-b", blob(1000));
    expect(second.stored).toBe(false);

    // photo-a's source survives — refusing photo-b never evicts anyone else.
    expect(await getPhotoSource(driver, "batch-1", "photo-a")).not.toBeNull();
    expect(await getPhotoSource(driver, "batch-1", "photo-b")).toBeNull();
  });

  it("replacing the same photo's source only counts its new size, not both old and new", async () => {
    const driver = createMemoryDriver();
    bulkStorageConfig.maxResidentSourceBytes = 1200;

    await savePhotoSource(driver, "batch-1", "photo-a", blob(1000));
    // Same key, a differently-sized re-save (e.g. a retry with a re-picked
    // file) — must not double-count the original 1000 bytes against the cap.
    const replaced = await savePhotoSource(driver, "batch-1", "photo-a", blob(1100));
    expect(replaced.stored).toBe(true);
  });

  it("a driver that throws on the blob write (a real QuotaExceededError) is caught and reported as not stored", async () => {
    const driver = createMemoryDriver();
    const originalPut = driver.put.bind(driver);
    driver.put = async (store, key, value) => {
      if (store === "photoBlobs") throw new DOMException("Quota exceeded", "QuotaExceededError");
      return originalPut(store, key, value);
    };

    const outcome = await savePhotoSource(driver, "batch-1", "photo-a", blob(10));
    expect(outcome.stored).toBe(false);
    expect(await getPhotoSource(driver, "batch-1", "photo-a")).toBeNull();
  });
});

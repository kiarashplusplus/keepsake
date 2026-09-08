import type { BatchItemSummary, BatchPhotoSummary, BatchSummary } from "@keepsake/contracts/bulk";
import {
  bulkBatchReducer,
  emptyBulkBatchState,
  itemFromSummary,
  listItems,
  listPhotosForItem,
  makeBulkBatchMeta,
  makeBulkDraftPhoto,
  pendingUploadPhotos,
  photoFromSummary,
  readyItemCount,
  rehydrateBulkBatchState,
  rehydratePhoto,
  unassignedPhotos,
  type BulkBatchState,
} from "@/features/bulk/batchStore";

function meta() {
  return makeBulkBatchMeta("batch-1", { name: "Mum's house", country: "US", postalCode: "94110" }, 1000);
}

function initial(): BulkBatchState {
  return emptyBulkBatchState(meta());
}

const ITEM_SUMMARY: BatchItemSummary = {
  id: "01DRAFTA000000000000000000",
  client_item_id: "item-a",
  title: "Blue mug",
  story: null,
  category: null,
  room_label: null,
  lot_label: null,
  aspects: [],
  photo_client_ids: ["photo-a"],
  state: "editing",
  revision: 1,
  listing_id: null,
  ready: false,
  blocked_reason: "Add a story.",
  created_at: 1000,
  updated_at: 1000,
};

const PHOTO_SUMMARY: BatchPhotoSummary = {
  client_photo_id: "photo-a",
  photo_id: "01SNAPA0000000000000000000",
  item_client_id: "item-a",
  position: 0,
  url_thumb: "https://keepsake.ing/i/01SNAPA0000000000000000000/thumb",
};

const BATCH_SUMMARY: BatchSummary = {
  id: "01BATCHA000000000000000000",
  client_batch_key: "batch-1",
  name: "Mum's house",
  country: "US",
  postal_code: "94110",
  place_name: "San Francisco",
  admin1: "CA",
  shared_story: null,
  state: "draft",
  revision: 2,
  item_count: 1,
  ready_count: 0,
  photo_count: 1,
  created_at: 1000,
  updated_at: 2000,
  expires_at: 999999,
};

describe("bulkBatchReducer: items", () => {
  it("creates an item on first local edit and tracks insertion order", () => {
    let state = initial();
    state = bulkBatchReducer(state, { type: "upsert_item_local", clientItemId: "a", patch: { fields: { title: "Mug" } } });
    state = bulkBatchReducer(state, { type: "upsert_item_local", clientItemId: "b", patch: { fields: { title: "Vase" } } });

    expect(state.itemOrder).toEqual(["a", "b"]);
    expect(state.items.a?.fields.title).toBe("Mug");
    expect(state.items.a?.dirty).toBe(true);
  });

  it("merges fields rather than replacing them wholesale", () => {
    let state = initial();
    state = bulkBatchReducer(state, { type: "upsert_item_local", clientItemId: "a", patch: { fields: { title: "Mug" } } });
    state = bulkBatchReducer(state, { type: "upsert_item_local", clientItemId: "a", patch: { fields: { story: "A gift from a trip." } } });

    expect(state.items.a?.fields).toEqual({ title: "Mug", story: "A gift from a trip." });
  });

  it("item_synced clears dirty and adopts the server's ready/blocked_reason verbatim", () => {
    let state = initial();
    state = bulkBatchReducer(state, { type: "upsert_item_local", clientItemId: "item-a", patch: { fields: { title: "Blue mug" } } });
    state = bulkBatchReducer(state, { type: "item_synced", summary: ITEM_SUMMARY });

    const item = state.items["item-a"];
    expect(item).toMatchObject({ id: "01DRAFTA000000000000000000", ready: false, blockedReason: "Add a story.", dirty: false, revision: 1 });
    expect(state.itemOrder).toEqual(["item-a"]);
  });

  it("item_synced for a not-yet-locally-known item still appends it (e.g. loaded from GET batch)", () => {
    const state = bulkBatchReducer(initial(), { type: "item_synced", summary: ITEM_SUMMARY });
    expect(state.itemOrder).toEqual(["item-a"]);
    expect(state.items["item-a"]?.photoClientIds).toEqual(["photo-a"]);
  });

  it("remove_item drops it from both the map and the order, and is a no-op for an unknown id", () => {
    let state = bulkBatchReducer(initial(), { type: "upsert_item_local", clientItemId: "a", patch: {} });
    state = bulkBatchReducer(state, { type: "remove_item", clientItemId: "a" });
    expect(state.itemOrder).toEqual([]);
    expect(state.items.a).toBeUndefined();

    const unchanged = bulkBatchReducer(state, { type: "remove_item", clientItemId: "does-not-exist" });
    expect(unchanged).toBe(state);
  });

  it("item_sync_failed marks a known item failed and no-ops for an unknown one", () => {
    let state = bulkBatchReducer(initial(), { type: "upsert_item_local", clientItemId: "a", patch: {} });
    state = bulkBatchReducer(state, { type: "item_sync_failed", clientItemId: "a" });
    expect(state.items.a?.state).toBe("failed");

    const unchanged = bulkBatchReducer(state, { type: "item_sync_failed", clientItemId: "nope" });
    expect(unchanged).toBe(state);
  });
});

describe("bulkBatchReducer: photos", () => {
  it("add_photo, update_photo (no-op on unknown id), remove_photo", () => {
    let state = initial();
    const photo = makeBulkDraftPhoto("photo-a", {}, 1000);
    state = bulkBatchReducer(state, { type: "add_photo", photo });
    expect(state.photos["photo-a"]).toEqual(photo);

    const patched = bulkBatchReducer(state, { type: "update_photo", clientPhotoId: "photo-a", patch: { status: "uploading" } });
    expect(patched.photos["photo-a"]?.status).toBe("uploading");

    const noop = bulkBatchReducer(state, { type: "update_photo", clientPhotoId: "missing", patch: { status: "uploading" } });
    expect(noop).toBe(state);

    const removed = bulkBatchReducer(patched, { type: "remove_photo", clientPhotoId: "photo-a" });
    expect(removed.photos["photo-a"]).toBeUndefined();
  });

  it("photo_synced merges the server row onto the existing local photo, preserving fields the summary doesn't carry", () => {
    let state = initial();
    state = bulkBatchReducer(state, {
      type: "add_photo",
      photo: makeBulkDraftPhoto("photo-a", { localPreviewUrl: "blob:local-preview" }, 1000),
    });
    state = bulkBatchReducer(state, { type: "photo_synced", summary: PHOTO_SUMMARY });

    const photo = state.photos["photo-a"];
    expect(photo).toMatchObject({
      status: "complete",
      photoId: "01SNAPA0000000000000000000",
      urlThumb: PHOTO_SUMMARY.url_thumb,
      hasLocalSource: false,
      needsReselection: false,
    });
    // Never clobbered by a sync — the server doesn't know about it.
    expect(photo?.localPreviewUrl).toBe("blob:local-preview");
  });

  it("photo_synced for an unknown photo still creates one, rather than dropping the server's row", () => {
    const state = bulkBatchReducer(initial(), { type: "photo_synced", summary: PHOTO_SUMMARY });
    expect(state.photos["photo-a"]?.status).toBe("complete");
  });
});

describe("bulkBatchReducer: batch meta", () => {
  it("patch_batch_meta merges onto the existing meta", () => {
    const state = bulkBatchReducer(initial(), { type: "patch_batch_meta", patch: { name: "Renamed" } });
    expect(state.batch.name).toBe("Renamed");
    expect(state.batch.clientBatchKey).toBe("batch-1");
  });

  it("batch_synced replaces meta wholesale from the server", () => {
    const state = bulkBatchReducer(initial(), { type: "batch_synced", summary: BATCH_SUMMARY });
    expect(state.batch).toMatchObject({ id: "01BATCHA000000000000000000", revision: 2, placeName: "San Francisco" });
  });

  it("reset replaces the whole state with a fresh empty one for the given meta", () => {
    let state = bulkBatchReducer(initial(), { type: "upsert_item_local", clientItemId: "a", patch: {} });
    state = bulkBatchReducer(state, { type: "reset", meta: meta() });
    expect(state.itemOrder).toEqual([]);
    expect(state.items).toEqual({});
  });

  it("hydrate replaces the whole state verbatim", () => {
    const seeded: BulkBatchState = { batch: meta(), items: {}, itemOrder: ["x"], photos: {} };
    const state = bulkBatchReducer(initial(), { type: "hydrate", state: seeded });
    expect(state).toBe(seeded);
  });
});

describe("selectors", () => {
  it("listItems follows itemOrder, not object insertion", () => {
    let state = initial();
    state = bulkBatchReducer(state, { type: "upsert_item_local", clientItemId: "b", patch: {} });
    state = bulkBatchReducer(state, { type: "upsert_item_local", clientItemId: "a", patch: {} });
    expect(listItems(state).map((i) => i.clientItemId)).toEqual(["b", "a"]);
  });

  it("listPhotosForItem returns photos in the item's own order, skipping any that got removed", () => {
    let state = initial();
    state = bulkBatchReducer(state, { type: "item_synced", summary: { ...ITEM_SUMMARY, photo_client_ids: ["p1", "p2"] } });
    state = bulkBatchReducer(state, { type: "add_photo", photo: makeBulkDraftPhoto("p2", {}, 1000) });
    // p1 was never added as a photo record — e.g. it was deleted server-side
    // out from under a stale item read. Must not throw, just skip it.
    expect(listPhotosForItem(state, "item-a").map((p) => p.clientPhotoId)).toEqual(["p2"]);
    expect(listPhotosForItem(state, "no-such-item")).toEqual([]);
  });

  it("unassignedPhotos returns only photos with no item, sorted by position", () => {
    let state = initial();
    state = bulkBatchReducer(state, { type: "add_photo", photo: makeBulkDraftPhoto("p2", { position: 1 }, 1000) });
    state = bulkBatchReducer(state, { type: "add_photo", photo: makeBulkDraftPhoto("p1", { position: 0 }, 1000) });
    state = bulkBatchReducer(state, { type: "add_photo", photo: makeBulkDraftPhoto("grouped", { itemClientId: "item-a" }, 1000) });
    expect(unassignedPhotos(state).map((p) => p.clientPhotoId)).toEqual(["p1", "p2"]);
  });

  it("pendingUploadPhotos includes only queued/uploading, not complete or failed", () => {
    let state = initial();
    state = bulkBatchReducer(state, { type: "add_photo", photo: makeBulkDraftPhoto("queued", {}, 1000) });
    state = bulkBatchReducer(state, { type: "add_photo", photo: { ...makeBulkDraftPhoto("uploading", {}, 1000), status: "uploading" } });
    state = bulkBatchReducer(state, { type: "add_photo", photo: { ...makeBulkDraftPhoto("done", {}, 1000), status: "complete" } });
    state = bulkBatchReducer(state, { type: "add_photo", photo: { ...makeBulkDraftPhoto("failed", {}, 1000), status: "permanent_failure" } });
    expect(pendingUploadPhotos(state).map((p) => p.clientPhotoId).sort()).toEqual(["queued", "uploading"]);
  });

  it("readyItemCount counts only items the server has marked ready — never computed locally", () => {
    let state = initial();
    state = bulkBatchReducer(state, { type: "item_synced", summary: { ...ITEM_SUMMARY, client_item_id: "a", ready: true } });
    state = bulkBatchReducer(state, { type: "item_synced", summary: { ...ITEM_SUMMARY, client_item_id: "b", ready: false } });
    expect(readyItemCount(state)).toBe(1);
  });
});

describe("itemFromSummary / photoFromSummary", () => {
  it("itemFromSummary omits null title/story/category from fields rather than carrying nulls into DraftItemFields", () => {
    const item = itemFromSummary({ ...ITEM_SUMMARY, title: null });
    expect(item.fields).toEqual({ aspects: [] });
  });

  it("itemFromSummary includes non-null fields", () => {
    const item = itemFromSummary({ ...ITEM_SUMMARY, story: "A trip to Kyoto.", category: "home_kitchen" });
    expect(item.fields).toMatchObject({ title: "Blue mug", story: "A trip to Kyoto.", category: "home_kitchen" });
  });

  it("photoFromSummary falls back to a fresh photo when there's no local record to merge onto", () => {
    const photo = photoFromSummary(PHOTO_SUMMARY, null, 5000);
    expect(photo).toMatchObject({ clientPhotoId: "photo-a", status: "complete", hasLocalSource: false });
  });
});

describe("rehydration (what a page reload must undo)", () => {
  it("rehydratePhoto clears the local preview URL and resets an interrupted upload to queued", () => {
    const uploading = { ...makeBulkDraftPhoto("a", { localPreviewUrl: "blob:dead" }, 1000), status: "uploading" as const };
    const rehydrated = rehydratePhoto(uploading);
    expect(rehydrated.localPreviewUrl).toBeNull();
    expect(rehydrated.status).toBe("queued");
  });

  it("rehydratePhoto leaves a complete photo's status alone", () => {
    const done = { ...makeBulkDraftPhoto("a", {}, 1000), status: "complete" as const };
    expect(rehydrateBulkBatchState({ batch: meta(), items: {}, itemOrder: [], photos: { a: done } }).photos.a?.status).toBe("complete");
  });
});

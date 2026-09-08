import { MAX_PHOTOS } from "@keepsake/contracts/photo";
import { MAX_BATCH_ITEMS } from "@keepsake/contracts/bulk";
import { bulkBatchReducer, emptyBulkBatchState, makeBulkBatchMeta, makeBulkDraftPhoto, type BulkBatchState } from "@/features/bulk/batchStore";
import {
  planAddPhotosToItem,
  planDissolveItem,
  planGroupAsOneItem,
  planGroupOnePerPhoto,
  planRemovePhotoFromItem,
  planSetCoverPhoto,
} from "@/features/bulk/grouping";

function meta() {
  return makeBulkBatchMeta("batch-1", { name: "Mum's house", country: "US", postalCode: "94110" }, 1000);
}

/** A tray of `n` unassigned photos, `photo-0`..`photo-{n-1}`. */
function withTrayPhotos(n: number): BulkBatchState {
  let state = emptyBulkBatchState(meta());
  for (let i = 0; i < n; i += 1) {
    const photo = makeBulkDraftPhoto(`photo-${i}`, {}, 1000);
    state = bulkBatchReducer(state, { type: "add_photo", photo });
  }
  return state;
}

/** Groups `photoIds` into `itemClientId` via the ordinary reducer path
 * (mirrors what `useBulkWorkspace.ts`'s `applyLocalPlan` does), so grouping
 * tests can build a starting state with an existing group without going
 * through the planner under test. */
function grouped(state: BulkBatchState, itemClientId: string, photoIds: string[]): BulkBatchState {
  let next = bulkBatchReducer(state, { type: "upsert_item_local", clientItemId: itemClientId, patch: { photoClientIds: photoIds } });
  for (const clientPhotoId of photoIds) {
    next = bulkBatchReducer(next, { type: "update_photo", clientPhotoId, patch: { itemClientId } });
  }
  return next;
}

describe("planGroupAsOneItem", () => {
  it("groups selected tray photos into one new item, cover first", () => {
    const state = withTrayPhotos(3);
    const plan = planGroupAsOneItem(state, "item-1", ["photo-0", "photo-2"]);
    if ("reason" in plan) throw new Error(plan.reason);

    expect(plan.itemPatches).toEqual([{ clientItemId: "item-1", photoClientIds: ["photo-0", "photo-2"] }]);
    expect(plan.photoPatches).toEqual([
      { clientPhotoId: "photo-0", itemClientId: "item-1" },
      { clientPhotoId: "photo-2", itemClientId: "item-1" },
    ]);
    expect(plan.itemsToSave).toEqual(["item-1"]);
  });

  it("detaches a moved photo from its old item and resaves that item too", () => {
    let state = withTrayPhotos(3);
    state = grouped(state, "item-old", ["photo-0", "photo-1"]);

    const plan = planGroupAsOneItem(state, "item-new", ["photo-0", "photo-2"]);
    if ("reason" in plan) throw new Error(plan.reason);

    const oldPatch = plan.itemPatches.find((p) => p.clientItemId === "item-old");
    expect(oldPatch?.photoClientIds).toEqual(["photo-1"]);
    expect(plan.itemsToSave.sort()).toEqual(["item-new", "item-old"]);
  });

  it("refuses more than MAX_PHOTOS in one item", () => {
    const state = withTrayPhotos(MAX_PHOTOS + 1);
    const photoIds = Array.from({ length: MAX_PHOTOS + 1 }, (_, i) => `photo-${i}`);
    const plan = planGroupAsOneItem(state, "item-1", photoIds);
    expect("reason" in plan).toBe(true);
  });

  it("refuses to create a new item once the batch is at MAX_BATCH_ITEMS", () => {
    let state = withTrayPhotos(2);
    for (let i = 0; i < MAX_BATCH_ITEMS; i += 1) {
      state = bulkBatchReducer(state, { type: "upsert_item_local", clientItemId: `existing-${i}`, patch: {} });
    }
    const plan = planGroupAsOneItem(state, "item-new", ["photo-0"]);
    expect("reason" in plan).toBe(true);
  });
});

describe("planGroupOnePerPhoto", () => {
  it("mints one new item per selected photo, each holding exactly that photo", () => {
    const state = withTrayPhotos(2);
    let minted = 0;
    const plan = planGroupOnePerPhoto(state, ["photo-0", "photo-1"], () => `item-${minted++}`);
    if ("reason" in plan) throw new Error(plan.reason);

    expect(plan.itemPatches).toEqual(
      expect.arrayContaining([
        { clientItemId: "item-0", photoClientIds: ["photo-0"] },
        { clientItemId: "item-1", photoClientIds: ["photo-1"] },
      ]),
    );
    expect(plan.itemPatches).toHaveLength(2);
    expect(plan.itemsToSave.sort()).toEqual(["item-0", "item-1"]);
  });

  it("refuses to push the batch over MAX_BATCH_ITEMS", () => {
    let state = withTrayPhotos(5);
    for (let i = 0; i < MAX_BATCH_ITEMS - 2; i += 1) {
      state = bulkBatchReducer(state, { type: "upsert_item_local", clientItemId: `existing-${i}`, patch: {} });
    }
    const plan = planGroupOnePerPhoto(state, ["photo-0", "photo-1", "photo-2"], () => "new");
    expect("reason" in plan).toBe(true);
  });
});

describe("planAddPhotosToItem", () => {
  it("appends photos and detaches them from wherever they were", () => {
    let state = withTrayPhotos(4);
    state = grouped(state, "item-a", ["photo-0"]);
    state = grouped(state, "item-b", ["photo-1"]);

    const plan = planAddPhotosToItem(state, "item-a", ["photo-1", "photo-2"]);
    if ("reason" in plan) throw new Error(plan.reason);

    const aPatch = plan.itemPatches.find((p) => p.clientItemId === "item-a");
    expect(aPatch?.photoClientIds).toEqual(["photo-0", "photo-1", "photo-2"]);
    const bPatch = plan.itemPatches.find((p) => p.clientItemId === "item-b");
    expect(bPatch?.photoClientIds).toEqual([]);
  });

  it("is a no-op when every requested photo is already on the item", () => {
    let state = withTrayPhotos(2);
    state = grouped(state, "item-a", ["photo-0", "photo-1"]);
    const plan = planAddPhotosToItem(state, "item-a", ["photo-0"]);
    if ("reason" in plan) throw new Error(plan.reason);
    expect(plan.itemsToSave).toEqual([]);
  });

  it("refuses to exceed MAX_PHOTOS on the destination item", () => {
    let state = withTrayPhotos(MAX_PHOTOS + 1);
    state = grouped(
      state,
      "item-a",
      Array.from({ length: MAX_PHOTOS }, (_, i) => `photo-${i}`),
    );
    const plan = planAddPhotosToItem(state, "item-a", [`photo-${MAX_PHOTOS}`]);
    expect("reason" in plan).toBe(true);
  });
});

describe("planRemovePhotoFromItem", () => {
  it("returns the photo to the tray and resaves the item without it", () => {
    let state = withTrayPhotos(2);
    state = grouped(state, "item-a", ["photo-0", "photo-1"]);
    const plan = planRemovePhotoFromItem(state, "item-a", "photo-0");
    if ("reason" in plan) throw new Error(plan.reason);
    expect(plan.itemPatches).toEqual([{ clientItemId: "item-a", photoClientIds: ["photo-1"] }]);
    expect(plan.photoPatches).toEqual([{ clientPhotoId: "photo-0", itemClientId: null }]);
  });
});

describe("planSetCoverPhoto", () => {
  it("reorders so the chosen photo is first, with no ownership change", () => {
    let state = withTrayPhotos(3);
    state = grouped(state, "item-a", ["photo-0", "photo-1", "photo-2"]);
    const plan = planSetCoverPhoto(state, "item-a", "photo-2");
    if ("reason" in plan) throw new Error(plan.reason);
    expect(plan.itemPatches).toEqual([{ clientItemId: "item-a", photoClientIds: ["photo-2", "photo-0", "photo-1"] }]);
    expect(plan.photoPatches).toEqual([]);
  });

  it("refuses a photo that isn't part of the item", () => {
    let state = withTrayPhotos(2);
    state = grouped(state, "item-a", ["photo-0"]);
    const plan = planSetCoverPhoto(state, "item-a", "photo-1");
    expect("reason" in plan).toBe(true);
  });
});

describe("planDissolveItem", () => {
  it("releases every one of the item's photos back to the tray", () => {
    let state = withTrayPhotos(2);
    state = grouped(state, "item-a", ["photo-0", "photo-1"]);
    const { photoPatches } = planDissolveItem(state, "item-a");
    expect(photoPatches.sort((a, b) => a.clientPhotoId.localeCompare(b.clientPhotoId))).toEqual([
      { clientPhotoId: "photo-0", itemClientId: null },
      { clientPhotoId: "photo-1", itemClientId: null },
    ]);
  });
});

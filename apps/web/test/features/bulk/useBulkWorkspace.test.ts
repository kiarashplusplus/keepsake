/**
 * Tests for the bulk workspace hook — the layer this agent owns that
 * actually wires `batchStore.ts` + `storage.ts` + `uploadQueue.ts` +
 * `src/api/bulk.ts` together. `@/api/bulk` and `@/features/bulk/uploadQueue`
 * are mocked: the first three modules already have their own exhaustive
 * suites (`batchStore.test.ts`, `storage.test.ts`, `uploadQueue.test.ts`),
 * so this file's job is the wiring and the rules layered on top of it —
 * the server-fallback load path, resending an item's whole `fields` on
 * every save, and the human-choice markers a late suggestion must respect.
 */
import { act, renderHook, waitFor } from "@testing-library/react-native";
import type { BatchDetail, BatchItemSummary, BatchPhotoSummary, BatchSummary } from "@keepsake/contracts/bulk";
import { ApiError } from "@/api/client";
import * as bulkApi from "@/api/bulk";
import { getDefaultBulkStorageDriver, saveBatchMeta } from "@/features/bulk/storage";
import { makeBulkBatchMeta, type BulkBatchMeta } from "@/features/bulk/batchStore";
import { useBulkWorkspace } from "@/features/bulk/useBulkWorkspace";

jest.mock("@/api/bulk", () => ({
  listBatches: jest.fn(),
  getBatch: jest.fn(),
  createBatch: jest.fn(),
  updateBatch: jest.fn(),
  cancelBatch: jest.fn(),
  upsertBatchItem: jest.fn(),
  deleteBatchItem: jest.fn(),
  uploadBatchPhoto: jest.fn(),
  deleteBatchPhoto: jest.fn(),
  suggestBatchPhoto: jest.fn(),
  submitBatch: jest.fn(),
  listBatchOperations: jest.fn(),
  getOperation: jest.fn(),
}));

type TrackedQueue = {
  enqueue: jest.Mock;
  retry: jest.Mock;
  cancel: jest.Mock;
  destroy: jest.Mock;
  resume: jest.Mock;
};
let mockTrackedQueues: TrackedQueue[] = [];

jest.mock("@/features/bulk/uploadQueue", () => ({
  UploadQueue: jest.fn().mockImplementation(function (this: TrackedQueue & Record<string, unknown>) {
    this.enqueue = jest.fn();
    this.retry = jest.fn();
    this.cancel = jest.fn();
    this.destroy = jest.fn();
    this.resume = jest.fn().mockResolvedValue(undefined);
    mockTrackedQueues.push(this as unknown as TrackedQueue);
  }),
}));

let batchCounter = 0;
function freshBatchKey(): string {
  batchCounter += 1;
  return `batch-${batchCounter}`;
}

async function seedLocalBatch(clientBatchKey: string, patch: Partial<BulkBatchMeta> = {}): Promise<BulkBatchMeta> {
  const driver = getDefaultBulkStorageDriver();
  const meta: BulkBatchMeta = {
    ...makeBulkBatchMeta(clientBatchKey, { name: "Mum's house", country: "US", postalCode: "94110" }),
    id: "01BATCHA000000000000000000",
    revision: 1,
    expiresAt: Date.now() + 1000,
    ...patch,
  };
  await saveBatchMeta(driver, meta);
  return meta;
}

function itemSummary(overrides: Partial<BatchItemSummary> = {}): BatchItemSummary {
  return {
    id: "01ITEMA0000000000000000000",
    client_item_id: "item-a",
    title: null,
    story: null,
    category: null,
    room_label: null,
    lot_label: null,
    aspects: [],
    photo_client_ids: [],
    state: "editing",
    revision: 1,
    listing_id: null,
    ready: false,
    blocked_reason: "Add a story.",
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

function photoSummary(overrides: Partial<BatchPhotoSummary> = {}): BatchPhotoSummary {
  return {
    client_photo_id: "photo-a",
    photo_id: "01SNAPA0000000000000000000",
    item_client_id: null,
    position: 0,
    url_thumb: "https://keepsake.ing/i/01SNAPA0000000000000000000/thumb",
    ...overrides,
  };
}

function batchSummary(clientBatchKey: string, overrides: Partial<BatchSummary> = {}): BatchSummary {
  return {
    id: "01BATCHA000000000000000000",
    client_batch_key: clientBatchKey,
    name: "Mum's house",
    country: "US",
    postal_code: "94110",
    place_name: "San Francisco",
    admin1: "CA",
    shared_story: null,
    state: "draft",
    revision: 1,
    item_count: 0,
    ready_count: 0,
    photo_count: 0,
    created_at: 1000,
    updated_at: 1000,
    expires_at: 999999,
    ...overrides,
  };
}

describe("useBulkWorkspace", () => {
  beforeEach(() => {
    // jsdom has no `URL.createObjectURL`/`revokeObjectURL` — stubbed the
    // same way a real browser's object-URL registry behaves closely enough
    // for this hook's bookkeeping (mint a distinct token per call, accept
    // any string on revoke).
    let objectUrlCounter = 0;
    URL.createObjectURL = jest.fn(() => `blob:test-${(objectUrlCounter += 1)}`);
    URL.revokeObjectURL = jest.fn();

    mockTrackedQueues = [];
    window.localStorage.clear();
    jest.mocked(bulkApi.listBatches).mockReset().mockResolvedValue([]);
    jest.mocked(bulkApi.getBatch).mockReset();
    jest.mocked(bulkApi.upsertBatchItem).mockReset();
    jest.mocked(bulkApi.deleteBatchItem).mockReset();
    jest.mocked(bulkApi.uploadBatchPhoto).mockReset();
    jest.mocked(bulkApi.deleteBatchPhoto).mockReset();
    jest.mocked(bulkApi.suggestBatchPhoto).mockReset();
    jest.mocked(bulkApi.submitBatch).mockReset();
    jest.mocked(bulkApi.updateBatch).mockReset();
    jest.mocked(bulkApi.cancelBatch).mockReset();
    jest.mocked(bulkApi.listBatchOperations).mockReset().mockResolvedValue([]);
  });

  it("hydrates from local storage without touching the network", async () => {
    const key = freshBatchKey();
    await seedLocalBatch(key);

    const { result } = renderHook(() => useBulkWorkspace(key));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(bulkApi.listBatches).not.toHaveBeenCalled();
    expect(result.current.state.batch.name).toBe("Mum's house");
  });

  it("falls back to the server and persists what it finds, when local storage has nothing", async () => {
    const key = freshBatchKey();
    jest.mocked(bulkApi.listBatches).mockResolvedValue([batchSummary(key)]);
    const detail: BatchDetail = { ...batchSummary(key), items: [itemSummary()], photos: [photoSummary({ item_client_id: "item-a" })] };
    jest.mocked(bulkApi.getBatch).mockResolvedValue(detail);

    const { result } = renderHook(() => useBulkWorkspace(key));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    expect(result.current.state.items["item-a"]).toBeDefined();
    expect(result.current.state.photos["photo-a"]).toBeDefined();

    // A second mount now finds it locally, with no further network call.
    jest.mocked(bulkApi.listBatches).mockClear();
    const { result: second } = renderHook(() => useBulkWorkspace(key));
    await waitFor(() => expect(second.current.status).toBe("ready"));
    expect(bulkApi.listBatches).not.toHaveBeenCalled();
  });

  it("reports not_found when neither this device nor the server knows the batch", async () => {
    const key = freshBatchKey();
    jest.mocked(bulkApi.listBatches).mockResolvedValue([]);

    const { result } = renderHook(() => useBulkWorkspace(key));
    await waitFor(() => expect(result.current.status).toBe("not_found"));
  });

  it("reports unavailable, not not_found, when the API 404s the whole feature", async () => {
    const key = freshBatchKey();
    jest.mocked(bulkApi.listBatches).mockRejectedValue(new ApiError("not_found", "Not found.", 404));

    const { result } = renderHook(() => useBulkWorkspace(key));
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
  });

  it("addPhotos adds a tray photo and enqueues it on the upload queue", async () => {
    const key = freshBatchKey();
    await seedLocalBatch(key);
    const { result } = renderHook(() => useBulkWorkspace(key));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    await waitFor(() => expect(mockTrackedQueues).toHaveLength(1));

    const file = new File(["x"], "mug.jpg", { type: "image/jpeg" });
    await act(async () => {
      await result.current.addPhotos([file]);
    });

    const photoIds = Object.keys(result.current.state.photos);
    expect(photoIds).toHaveLength(1);
    expect(mockTrackedQueues[0]?.enqueue).toHaveBeenCalledWith(photoIds[0], file);
  });

  it("groups selected tray photos into one new item and saves it with no expected_revision (a create)", async () => {
    const key = freshBatchKey();
    await seedLocalBatch(key);
    jest.mocked(bulkApi.upsertBatchItem).mockResolvedValue({ ok: true, data: itemSummary({ client_item_id: "will-be-ignored" }) });

    const { result } = renderHook(() => useBulkWorkspace(key));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.addPhotos([new File(["a"], "a.jpg", { type: "image/jpeg" }), new File(["b"], "b.jpg", { type: "image/jpeg" })]);
    });
    const photoIds = Object.keys(result.current.state.photos);

    let outcome: { ok: boolean } | undefined;
    await act(async () => {
      outcome = await result.current.groupAsOneItem(photoIds);
    });

    expect(outcome?.ok).toBe(true);
    expect(bulkApi.upsertBatchItem).toHaveBeenCalledTimes(1);
    const [, , body] = jest.mocked(bulkApi.upsertBatchItem).mock.calls[0]!;
    expect(body.expected_revision).toBeUndefined();
    expect(body.photo_client_ids).toEqual(photoIds);
  });

  it("resends an item's whole current fields on a photo-only regroup, never a partial patch", async () => {
    const key = freshBatchKey();
    await seedLocalBatch(key);
    // Echoes back whatever `client_item_id` it was called with, and settles
    // title/story as if the server had just accepted them — the shape a
    // real `PUT` response takes.
    jest.mocked(bulkApi.upsertBatchItem).mockImplementation((_batchId, clientItemId) =>
      Promise.resolve({
        ok: true,
        data: itemSummary({ client_item_id: clientItemId, title: "Blue mug", story: "A gift from Nan.", photo_client_ids: ["photo-0"], revision: 1 }),
      }),
    );

    const { result } = renderHook(() => useBulkWorkspace(key));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.addPhotos([new File(["a"], "a.jpg", { type: "image/jpeg" }), new File(["b"], "b.jpg", { type: "image/jpeg" })]);
    });
    const [photoA, photoB] = Object.keys(result.current.state.photos);

    // First save: the item gets a title and a story, and the server echoes
    // them back (as a real PUT response would) with `revision: 1`.
    await act(async () => {
      await result.current.groupAsOneItem([photoA as string]);
    });
    const [itemClientId] = Object.keys(result.current.state.items);
    expect(itemClientId).toBeDefined();

    jest.mocked(bulkApi.upsertBatchItem).mockClear();
    jest.mocked(bulkApi.upsertBatchItem).mockResolvedValue({
      ok: true,
      data: itemSummary({
        client_item_id: itemClientId as string,
        title: "Blue mug",
        story: "A gift from Nan.",
        photo_client_ids: [photoA as string, photoB as string],
        revision: 2,
      }),
    });

    // Now regroup — add a second photo, with no field edits at all — via
    // the item's own `addPhotosToItem`.
    await act(async () => {
      await result.current.addPhotosToItem(itemClientId as string, [photoB as string]);
    });

    expect(bulkApi.upsertBatchItem).toHaveBeenCalledTimes(1);
    const [, , body] = jest.mocked(bulkApi.upsertBatchItem).mock.calls[0]!;
    // The whole point: even though only photos changed, `fields` still
    // carries whatever this item's local state believes its title/story to
    // be — never an empty/partial object that would wipe them server-side
    // (see `apps/api/src/routes/bulk.ts`'s item-upsert handler).
    expect(body.fields).toEqual({ title: "Blue mug", story: "A gift from Nan.", aspects: [] });
  });

  it("preserves a giver-typed title against a late suggestion, but fills an empty one", async () => {
    const key = freshBatchKey();
    await seedLocalBatch(key);
    // See the staleness test below for why an omitted `photo_client_ids`
    // must echo the *previous* list, not `[]`.
    let lastPhotoClientIds: string[] = [];
    jest.mocked(bulkApi.upsertBatchItem).mockImplementation((_batchId, clientItemId, input) => {
      if (input.photo_client_ids !== undefined) lastPhotoClientIds = input.photo_client_ids;
      return Promise.resolve({
        ok: true,
        data: itemSummary({
          client_item_id: clientItemId,
          title: input.fields.title ?? null,
          category: input.fields.category ?? null,
          photo_client_ids: lastPhotoClientIds,
          revision: 2,
        }),
      });
    });
    jest.mocked(bulkApi.suggestBatchPhoto).mockResolvedValue({
      ok: true,
      data: {
        subject: "a mug",
        markings: "",
        title: "Blue mug",
        category: "home_kitchen",
        condition: "some wear on the handle",
        aspects: [],
      },
    });

    const { result } = renderHook(() => useBulkWorkspace(key));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.addPhotos([new File(["a"], "a.jpg", { type: "image/jpeg" })]);
    });
    const [photoId] = Object.keys(result.current.state.photos);
    // The photo must already be "uploaded" (carry a photoId) for a
    // suggestion to be worth asking for — `requestSuggestionInternal`
    // refuses otherwise.
    act(() => {
      result.current.state.photos[photoId as string]!.photoId = "01SNAPA0000000000000000000";
    });

    await act(async () => {
      await result.current.groupAsOneItem([photoId as string]);
    });
    const [itemClientId] = Object.keys(result.current.state.items);

    await waitFor(() => expect(result.current.state.items[itemClientId as string]?.fields.title).toBe("Blue mug"));
    expect(result.current.markerFor(itemClientId as string).appliedSuggestionPhotoId).toBe(photoId);

    // The giver now types their own title.
    act(() => {
      result.current.setItemTitle(itemClientId as string, "Nan's blue mug");
    });
    expect(result.current.markerFor(itemClientId as string).titleDirty).toBe(true);

    // A second suggestion request (e.g. a manual retry) must not clobber it.
    await act(async () => {
      await result.current.requestSuggestion(itemClientId as string);
    });
    expect(result.current.state.items[itemClientId as string]?.fields.title).toBe("Nan's blue mug");
  });

  it("marks an applied suggestion stale once the cover photo changes, and a failed suggestion never sets one", async () => {
    const key = freshBatchKey();
    await seedLocalBatch(key);
    // Mirrors the real server's "omitted `photo_client_ids` leaves the
    // photo list unchanged" rule (unlike `fields`, which the real route
    // always overwrites in full — see `useBulkWorkspace.ts`'s header) so a
    // save that only patches fields doesn't echo back an empty photo list.
    let lastPhotoClientIds: string[] = [];
    jest.mocked(bulkApi.upsertBatchItem).mockImplementation((_batchId, clientItemId, input) => {
      if (input.photo_client_ids !== undefined) lastPhotoClientIds = input.photo_client_ids;
      return Promise.resolve({ ok: true, data: itemSummary({ client_item_id: clientItemId, photo_client_ids: lastPhotoClientIds, revision: 2 }) });
    });
    // The first cover's suggestion fails outright — must never set a marker.
    jest.mocked(bulkApi.suggestBatchPhoto).mockResolvedValueOnce({ ok: false, error: { kind: "limit_reached", message: "No suggestions left." } });

    const { result } = renderHook(() => useBulkWorkspace(key));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await result.current.addPhotos([new File(["a"], "a.jpg", { type: "image/jpeg" }), new File(["b"], "b.jpg", { type: "image/jpeg" })]);
    });
    const [photoA, photoB] = Object.keys(result.current.state.photos);
    act(() => {
      result.current.state.photos[photoA as string]!.photoId = "01SNAPA0000000000000000000";
      result.current.state.photos[photoB as string]!.photoId = "01SNAPB0000000000000000000";
    });

    await act(async () => {
      await result.current.groupAsOneItem([photoA as string, photoB as string]);
    });
    const [itemClientId] = Object.keys(result.current.state.items);

    // A failed suggestion is a no-op, not a block — no marker set yet.
    expect(result.current.markerFor(itemClientId as string).appliedSuggestionPhotoId).toBeNull();
    expect(result.current.isSuggestionStale(itemClientId as string)).toBe(false);

    // A manual retry for the same cover now succeeds.
    jest.mocked(bulkApi.suggestBatchPhoto).mockResolvedValueOnce({
      ok: true,
      data: { subject: "a mug", markings: "", title: "Blue mug", category: "home_kitchen", condition: "chipped rim", aspects: [] },
    });
    await act(async () => {
      await result.current.requestSuggestion(itemClientId as string);
    });
    expect(result.current.markerFor(itemClientId as string).appliedSuggestionPhotoId).toBe(photoA);
    expect(result.current.isSuggestionStale(itemClientId as string)).toBe(false);

    // Now the giver re-covers to photo B — `setCoverPhoto` itself tries a
    // fresh autofill for the new cover; keep that one pending so the marker
    // under test still reflects photo A when we assert staleness.
    let releaseSecondSuggestion: (() => void) | undefined;
    jest.mocked(bulkApi.suggestBatchPhoto).mockImplementationOnce(
      () => new Promise((resolve) => { releaseSecondSuggestion = () => resolve({ ok: true, data: null }); }),
    );
    await act(async () => {
      await result.current.setCoverPhoto(itemClientId as string, photoB as string);
    });

    expect(result.current.state.items[itemClientId as string]?.photoClientIds[0]).toBe(photoB);
    // The marker still names photo A's suggestion, which is no longer the
    // cover — exactly what "stale" means.
    expect(result.current.isSuggestionStale(itemClientId as string)).toBe(true);

    await act(async () => {
      releaseSecondSuggestion?.();
      await Promise.resolve();
    });
  });

  it("previews the shared-story application and refuses to exceed STORY_MAX or duplicate", async () => {
    const key = freshBatchKey();
    const shared = "From my mother's kitchen, 1962.";
    await seedLocalBatch(key, { sharedStory: shared });
    jest.mocked(bulkApi.upsertBatchItem).mockImplementation((_batchId, clientItemId, input) =>
      Promise.resolve({ ok: true, data: itemSummary({ client_item_id: clientItemId, story: input.fields.story ?? null, revision: 2 }) }),
    );

    const { result } = renderHook(() => useBulkWorkspace(key));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.state.items["item-empty"] = {
        clientItemId: "item-empty",
        id: null,
        fields: {},
        roomLabel: null,
        lotLabel: null,
        photoClientIds: [],
        state: "editing",
        revision: 1,
        listingId: null,
        ready: null,
        blockedReason: null,
        dirty: false,
        createdAt: 0,
        updatedAt: 0,
      };
      result.current.state.itemOrder.push("item-empty");
      result.current.state.items["item-already"] = {
        ...result.current.state.items["item-empty"]!,
        clientItemId: "item-already",
        fields: { story: shared },
      };
      result.current.state.itemOrder.push("item-already");
      result.current.state.items["item-nearly-full"] = {
        ...result.current.state.items["item-empty"]!,
        clientItemId: "item-nearly-full",
        // Close enough to STORY_MAX (2000) that appending the shared story
        // (32 chars) tips it over, so the length guard is what has to catch
        // this — the "already included" and "empty" checks above wouldn't.
        fields: { story: "A".repeat(1990) },
      };
      result.current.state.itemOrder.push("item-nearly-full");
    });

    const preview = result.current.previewSharedStoryApplication(["item-empty", "item-already", "item-nearly-full"]);
    const empty = preview.find((p) => p.itemClientId === "item-empty");
    const already = preview.find((p) => p.itemClientId === "item-already");
    const nearlyFull = preview.find((p) => p.itemClientId === "item-nearly-full");
    expect(empty?.skipped).toBe(false);
    expect(empty?.after).toBe(shared);
    expect(already?.skipped).toBe(true);
    expect(already?.reason).toMatch(/already/i);
    expect(nearlyFull?.skipped).toBe(true);
    expect(nearlyFull?.reason).toMatch(/2000 characters/i);
    // The preview must never propose text past the real limit, even for a
    // caller that ignored `skipped` and applied `after` blindly.
    expect(nearlyFull?.after.length).toBeLessThanOrEqual(2000);

    let outcome: { applied: number; skipped: number } | undefined;
    await act(async () => {
      outcome = await result.current.applySharedStoryToSelected(["item-empty", "item-already", "item-nearly-full"]);
    });
    expect(outcome).toEqual({ applied: 1, skipped: 2 });
  });

  it("submits only the selected items, each at its known revision", async () => {
    const key = freshBatchKey();
    await seedLocalBatch(key);
    jest.mocked(bulkApi.submitBatch).mockResolvedValue({
      ok: true,
      data: { id: "01OPA0000000000000000000A", batch_id: "01BATCHA000000000000000000", kind: "submit", status: "queued", total: 1, succeeded: 0, failed: 0, created_at: 1, updated_at: 1, finished_at: null },
    });

    const { result } = renderHook(() => useBulkWorkspace(key));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => {
      result.current.state.items["item-ready"] = {
        clientItemId: "item-ready",
        id: "01ITEMA0000000000000000000",
        fields: { title: "Blue mug", story: "A".repeat(30), category: "home_kitchen", aspects: [] },
        roomLabel: null,
        lotLabel: null,
        photoClientIds: ["photo-a"],
        state: "ready",
        revision: 3,
        listingId: null,
        ready: true,
        blockedReason: null,
        dirty: false,
        createdAt: 0,
        updatedAt: 0,
      };
      result.current.state.itemOrder.push("item-ready");
    });

    let outcome: Awaited<ReturnType<typeof result.current.submitItems>> | undefined;
    await act(async () => {
      outcome = await result.current.submitItems(["item-ready"], "1990-01-01");
    });

    expect(outcome?.ok).toBe(true);
    expect(bulkApi.submitBatch).toHaveBeenCalledWith(
      "01BATCHA000000000000000000",
      expect.objectContaining({ date_of_birth: "1990-01-01", items: [{ client_item_id: "item-ready", revision: 3 }] }),
    );
  });

  it("refuses to submit when nothing selected has a known revision yet", async () => {
    const key = freshBatchKey();
    await seedLocalBatch(key);
    const { result } = renderHook(() => useBulkWorkspace(key));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let outcome: Awaited<ReturnType<typeof result.current.submitItems>> | undefined;
    await act(async () => {
      outcome = await result.current.submitItems(["nope"], "1990-01-01");
    });
    expect(outcome?.ok).toBe(false);
    expect(bulkApi.submitBatch).not.toHaveBeenCalled();
  });
});

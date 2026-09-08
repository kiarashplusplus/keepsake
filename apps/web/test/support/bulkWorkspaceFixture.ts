/**
 * A fully-stubbed `UseBulkWorkspaceResult`, for screen tests under
 * `test/app/bulk/` that mock `@/features/bulk/BulkWorkspaceContext`'s
 * `useBulkWorkspaceContext` rather than standing up the real provider (and,
 * behind it, `@/api/bulk` + IndexedDB) — the hook itself already has its
 * own exhaustive suite (`test/features/bulk/useBulkWorkspace.test.ts`), so
 * screen tests only need a workspace shaped correctly, not a real one.
 */
import { emptyBulkBatchState, makeBulkBatchMeta, type BulkBatchState } from "@/features/bulk/batchStore";
import { EMPTY_ITEM_MARKER } from "@/features/bulk/itemMarkers";
import type { UseBulkWorkspaceResult } from "@/features/bulk/useBulkWorkspace";

export function fixtureBatchState(overrides: Partial<BulkBatchState> = {}): BulkBatchState {
  const meta = {
    ...makeBulkBatchMeta("batch-1", { name: "Mum's house — September", country: "US", postalCode: "94110" }, 1000),
    id: "01BATCHA000000000000000000",
    revision: 1,
    expiresAt: Date.now() + 1000 * 60 * 60 * 24,
  };
  return { ...emptyBulkBatchState(meta), ...overrides };
}

export function makeWorkspaceFixture(overrides: Partial<UseBulkWorkspaceResult> = {}): UseBulkWorkspaceResult {
  return {
    status: "ready",
    state: fixtureBatchState(),
    markers: {},
    markerFor: jest.fn(() => EMPTY_ITEM_MARKER),
    isSuggestionStale: jest.fn(() => false),
    suggestionLoading: {},
    uploadPausedUntil: null,
    updateBatchMeta: jest.fn(async () => null),
    cancelBatch: jest.fn(async () => ({ ok: true as const, data: { id: "01BATCHA000000000000000000" } })),
    addPhotos: jest.fn(async () => undefined),
    removePhoto: jest.fn(async () => undefined),
    retryPhoto: jest.fn(),
    groupAsOneItem: jest.fn(async () => ({ ok: true })),
    groupOnePerPhoto: jest.fn(async () => ({ ok: true })),
    addPhotosToItem: jest.fn(async () => ({ ok: true })),
    removePhotoFromItem: jest.fn(async () => ({ ok: true })),
    setCoverPhoto: jest.fn(async () => ({ ok: true })),
    dissolveItem: jest.fn(async () => undefined),
    setItemTitle: jest.fn(),
    setItemStory: jest.fn(),
    setItemCategory: jest.fn(),
    setItemLabels: jest.fn(),
    saveItem: jest.fn(async () => null),
    requestSuggestion: jest.fn(async () => undefined),
    suggestionForPhoto: jest.fn(() => null),
    applyRoomLabelToSelected: jest.fn(async () => undefined),
    applyLotLabelToSelected: jest.fn(async () => undefined),
    previewSharedStoryApplication: jest.fn(() => []),
    applySharedStoryToSelected: jest.fn(async () => ({ applied: 0, skipped: 0 })),
    operations: [],
    refreshOperations: jest.fn(async () => undefined),
    submitItems: jest.fn(async () => ({
      ok: true as const,
      data: {
        id: "01OPA0000000000000000000A",
        batch_id: "01BATCHA000000000000000000",
        kind: "submit" as const,
        status: "queued" as const,
        total: 1,
        succeeded: 0,
        failed: 0,
        created_at: 1,
        updated_at: 1,
        finished_at: null,
      },
    })),
    ...overrides,
  };
}

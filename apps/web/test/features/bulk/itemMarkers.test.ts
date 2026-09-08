import { EMPTY_ITEM_MARKER, isSuggestionStale, loadItemMarkers, markerFor, saveItemMarkers } from "@/features/bulk/itemMarkers";

describe("itemMarkers", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns the empty marker for an item nothing has recorded yet", () => {
    expect(markerFor({}, "item-1")).toBe(EMPTY_ITEM_MARKER);
  });

  it("round-trips through storage", () => {
    saveItemMarkers("batch-1", { "item-1": { titleDirty: true, categoryChosen: false, appliedSuggestionPhotoId: "photo-1" } });
    expect(loadItemMarkers("batch-1")).toEqual({ "item-1": { titleDirty: true, categoryChosen: false, appliedSuggestionPhotoId: "photo-1" } });
  });

  it("keeps markers for different batches apart", () => {
    saveItemMarkers("batch-1", { "item-1": { titleDirty: true, categoryChosen: false, appliedSuggestionPhotoId: null } });
    saveItemMarkers("batch-2", { "item-1": { titleDirty: false, categoryChosen: true, appliedSuggestionPhotoId: null } });
    expect(loadItemMarkers("batch-1")["item-1"]?.titleDirty).toBe(true);
    expect(loadItemMarkers("batch-2")["item-1"]?.categoryChosen).toBe(true);
  });

  it("degrades to no markers rather than throwing on a corrupt value", () => {
    window.localStorage.setItem("keepsake.bulk.markers.v1.batch-1", "not json{{{");
    expect(loadItemMarkers("batch-1")).toEqual({});

    window.localStorage.setItem("keepsake.bulk.markers.v1.batch-1", JSON.stringify({ "item-1": { garbage: true } }));
    expect(loadItemMarkers("batch-1")).toEqual({});
  });

  describe("isSuggestionStale", () => {
    it("is false when no suggestion has ever been applied", () => {
      expect(isSuggestionStale({}, "item-1", "photo-1")).toBe(false);
    });

    it("is false while the applied suggestion's cover is still the current cover", () => {
      const markers = { "item-1": { titleDirty: false, categoryChosen: false, appliedSuggestionPhotoId: "photo-1" } };
      expect(isSuggestionStale(markers, "item-1", "photo-1")).toBe(false);
    });

    it("is true once the cover has changed away from the applied suggestion's photo", () => {
      const markers = { "item-1": { titleDirty: false, categoryChosen: false, appliedSuggestionPhotoId: "photo-1" } };
      expect(isSuggestionStale(markers, "item-1", "photo-2")).toBe(true);
    });
  });
});

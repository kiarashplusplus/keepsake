import type { PhotoSuggestion } from "@keepsake/contracts/photo";
import {
  GIVE_DRAFT_INITIAL,
  coverPhoto,
  deserializeGiveDraft,
  giveDraftReducer,
  serializeGiveDraft,
  type GiveDraft,
  type GiveDraftPhoto,
} from "@/features/give/giveDraft";

function photo(clientId: string, overrides: Partial<GiveDraftPhoto> = {}): GiveDraftPhoto {
  return {
    clientId,
    id: null,
    objectUrl: null,
    width: 100,
    height: 100,
    blurhash: "abc",
    status: "uploading",
    error: null,
    errorCode: null,
    canRetry: false,
    ...overrides,
  };
}

const SUGGESTION: PhotoSuggestion = {
  subject: "a ceramic mug",
  markings: "",
  title: "Blue ceramic mug",
  category: "home_kitchen",
  condition: "small chip near the handle",
  aspects: [{ name: "material", value: "ceramic" }],
};

describe("giveDraftReducer", () => {
  it("adds and removes photos", () => {
    let state = giveDraftReducer(GIVE_DRAFT_INITIAL, { type: "add_photo", photo: photo("a") });
    expect(state.photos).toHaveLength(1);

    state = giveDraftReducer(state, { type: "remove_photo", clientId: "a" });
    expect(state.photos).toHaveLength(0);
  });

  it("patches a photo in place by clientId", () => {
    let state = giveDraftReducer(GIVE_DRAFT_INITIAL, { type: "add_photo", photo: photo("a") });
    state = giveDraftReducer(state, { type: "update_photo", clientId: "a", patch: { status: "done", id: "01PHOTO" } });

    expect(state.photos[0]).toMatchObject({ clientId: "a", status: "done", id: "01PHOTO" });
  });

  it("swaps two photos on move_photo", () => {
    let state = giveDraftReducer(GIVE_DRAFT_INITIAL, { type: "add_photo", photo: photo("a") });
    state = giveDraftReducer(state, { type: "add_photo", photo: photo("b") });
    state = giveDraftReducer(state, { type: "move_photo", clientId: "b", direction: -1 });

    expect(state.photos.map((p) => p.clientId)).toEqual(["b", "a"]);
  });

  it("ignores a move past either boundary", () => {
    let state = giveDraftReducer(GIVE_DRAFT_INITIAL, { type: "add_photo", photo: photo("a") });
    state = giveDraftReducer(state, { type: "move_photo", clientId: "a", direction: -1 });
    expect(state.photos.map((p) => p.clientId)).toEqual(["a"]);

    state = giveDraftReducer(state, { type: "move_photo", clientId: "a", direction: 1 });
    expect(state.photos.map((p) => p.clientId)).toEqual(["a"]);
  });

  it("sets every simple field", () => {
    let state = giveDraftReducer(GIVE_DRAFT_INITIAL, { type: "set_title", title: "A mug" });
    state = giveDraftReducer(state, { type: "set_story", story: "A".repeat(30) });
    state = giveDraftReducer(state, { type: "set_country", country: "CA" });
    state = giveDraftReducer(state, { type: "set_postal_code", postalCode: "M5V" });
    state = giveDraftReducer(state, { type: "set_email", email: "a@b.com" });
    state = giveDraftReducer(state, { type: "set_listing_id", listingId: "01LISTING" });

    expect(state).toMatchObject({
      title: "A mug",
      story: "A".repeat(30),
      country: "CA",
      postalCode: "M5V",
      email: "a@b.com",
      listingId: "01LISTING",
    });
  });

  it("resets to exactly the initial draft", () => {
    const dirtied = giveDraftReducer(GIVE_DRAFT_INITIAL, { type: "set_title", title: "x" });
    expect(giveDraftReducer(dirtied, { type: "reset" })).toEqual(GIVE_DRAFT_INITIAL);
  });

  it("marks titleDirty on set_title even when the new title is empty", () => {
    let state = giveDraftReducer(GIVE_DRAFT_INITIAL, { type: "set_title", title: "A mug" });
    expect(state.titleDirty).toBe(true);

    state = giveDraftReducer(state, { type: "set_title", title: "" });
    expect(state.titleDirty).toBe(true);
    expect(GIVE_DRAFT_INITIAL.titleDirty).toBe(false);
  });
});

describe("coverPhoto", () => {
  it("is null when no photo has finished uploading", () => {
    const state = giveDraftReducer(GIVE_DRAFT_INITIAL, { type: "add_photo", photo: photo("a") });
    expect(coverPhoto(state)).toBeNull();
  });

  it("is the first done photo, not necessarily index 0", () => {
    let state = giveDraftReducer(GIVE_DRAFT_INITIAL, { type: "add_photo", photo: photo("a", { status: "error", error: "nope" }) });
    state = giveDraftReducer(state, { type: "add_photo", photo: photo("b", { status: "done", id: "01PHOTOB" }) });

    expect(coverPhoto(state)?.clientId).toBe("b");
  });
});

describe("set_suggestion", () => {
  function draftWithCover(): GiveDraft {
    return giveDraftReducer(GIVE_DRAFT_INITIAL, { type: "add_photo", photo: photo("cover", { status: "done", id: "01PHOTOCOVER" }) });
  }

  it("fills title from the cover's suggestion when untouched, and always takes its category (issue #35: no picker to defer to)", () => {
    const state = giveDraftReducer(draftWithCover(), { type: "set_suggestion", photoId: "01PHOTOCOVER", suggestion: SUGGESTION });

    expect(state.title).toBe(SUGGESTION.title);
    expect(state.category).toBe(SUGGESTION.category);
    expect(state.appliedSuggestionPhotoId).toBe("01PHOTOCOVER");
    expect(state.suggestions["01PHOTOCOVER"]).toEqual(SUGGESTION);
  });

  it("never overwrites a title the giver already typed (titleDirty), even an empty one — but still takes the suggested category", () => {
    let state = draftWithCover();
    state = giveDraftReducer(state, { type: "set_title", title: "" });
    state = giveDraftReducer(state, { type: "set_suggestion", photoId: "01PHOTOCOVER", suggestion: SUGGESTION });

    expect(state.title).toBe("");
    // Unlike title, category has no "the giver already set it" case to
    // defer to — issue #35 removed the only UI that could ever set it.
    expect(state.category).toBe(SUGGESTION.category);
  });

  it("a later suggestion for the same cover overwrites an earlier suggestion's category too", () => {
    let state = draftWithCover();
    state = giveDraftReducer(state, { type: "set_suggestion", photoId: "01PHOTOCOVER", suggestion: SUGGESTION });
    expect(state.category).toBe("home_kitchen");

    const reSuggested: PhotoSuggestion = { ...SUGGESTION, category: "books_letters" };
    state = giveDraftReducer(state, { type: "set_suggestion", photoId: "01PHOTOCOVER", suggestion: reSuggested });
    expect(state.category).toBe("books_letters");
  });

  it("caches a suggestion for a non-cover photo without touching title/category", () => {
    let state = draftWithCover();
    state = giveDraftReducer(state, { type: "add_photo", photo: photo("second", { status: "done", id: "01PHOTOSECOND" }) });
    // "cover" is still the cover (first done photo) — a suggestion for the
    // second photo must be cached but not applied.
    state = giveDraftReducer(state, { type: "set_suggestion", photoId: "01PHOTOSECOND", suggestion: SUGGESTION });

    expect(state.title).toBe("");
    expect(state.category).toBe("other"); // GIVE_DRAFT_INITIAL's default — untouched
    expect(state.appliedSuggestionPhotoId).toBeNull();
    expect(state.suggestions["01PHOTOSECOND"]).toEqual(SUGGESTION);
  });

  it("a later suggestion for a new cover can still fill an untouched title", () => {
    let state = draftWithCover();
    state = giveDraftReducer(state, { type: "add_photo", photo: photo("second", { status: "done", id: "01PHOTOSECOND" }) });
    state = giveDraftReducer(state, { type: "set_suggestion", photoId: "01PHOTOCOVER", suggestion: SUGGESTION });
    expect(state.title).toBe(SUGGESTION.title);
    expect(state.appliedSuggestionPhotoId).toBe("01PHOTOCOVER");

    // The cover changes (the original cover photo is removed) and a fresh
    // suggestion arrives for the new one. Since the giver never typed
    // anything themselves (`titleDirty` stayed false — this was applied by
    // `set_suggestion`, never `set_title`), the new suggestion still wins:
    // staleness is decidable (the old note's `appliedSuggestionPhotoId` no
    // longer matches the cover) rather than the title being locked in
    // forever by the first photo's guess.
    state = giveDraftReducer(state, { type: "remove_photo", clientId: "cover" });
    const second: PhotoSuggestion = { ...SUGGESTION, title: "Copper teapot" };
    state = giveDraftReducer(state, { type: "set_suggestion", photoId: "01PHOTOSECOND", suggestion: second });

    expect(coverPhoto(state)?.id).toBe("01PHOTOSECOND");
    expect(state.title).toBe("Copper teapot");
    expect(state.appliedSuggestionPhotoId).toBe("01PHOTOSECOND");
  });
});

describe("give draft serialization", () => {
  it("round-trips a draft through serialize/deserialize", () => {
    const state = giveDraftReducer(GIVE_DRAFT_INITIAL, { type: "set_title", title: "Round trip" });

    expect(deserializeGiveDraft(serializeGiveDraft(state))).toEqual(state);
  });

  it("falls back to null on invalid JSON rather than throwing", () => {
    expect(deserializeGiveDraft("not json")).toBeNull();
  });

  it("falls back to null for a JSON value that isn't an object", () => {
    expect(deserializeGiveDraft("42")).toBeNull();
  });

  it("GUARD: nulls out a photo's objectUrl on rehydrate — a blob URL doesn't survive the document that made it", () => {
    const state = giveDraftReducer(GIVE_DRAFT_INITIAL, {
      type: "add_photo",
      photo: photo("a", { status: "done", id: "01PHOTO", objectUrl: "blob:http://localhost/dead-on-reload" }),
    });

    const rehydrated = deserializeGiveDraft(serializeGiveDraft(state));

    expect(rehydrated?.photos[0]?.objectUrl).toBeNull();
    // Nothing else about the photo is lost — only the blob URL, which is
    // the one field that genuinely can't survive a reload.
    expect(rehydrated?.photos[0]).toMatchObject({ clientId: "a", id: "01PHOTO", status: "done" });
  });

  // Guard validated by breaking it: dropping the `status === "uploading"`
  // spread from `deserializeGiveDraft` made this fail on the first
  // expectation — the tile came back `"uploading"`, which is what a giver
  // who left mid-upload and came back used to meet: "uploading…" forever,
  // no retry, `Continue` disabled. Restored afterward.
  it("GUARD: a tile persisted mid-upload comes back as a failed one, not a stuck one", () => {
    const state = giveDraftReducer(GIVE_DRAFT_INITIAL, {
      type: "add_photo",
      photo: photo("a", { status: "uploading", objectUrl: "blob:http://localhost/preview" }),
    });

    const rehydrated = deserializeGiveDraft(serializeGiveDraft(state));

    expect(rehydrated?.photos[0]).toMatchObject({
      clientId: "a",
      status: "error",
      errorCode: "interrupted",
      error: expect.stringMatching(/didn't finish/),
      // No source `File` survives the reload, so no retry is offered — the
      // same reasoning `canRetry` already gets on every rehydrate.
      canRetry: false,
      objectUrl: null,
    });
  });

  it("leaves a finished tile's status alone on rehydrate", () => {
    const state = giveDraftReducer(GIVE_DRAFT_INITIAL, { type: "add_photo", photo: photo("a", { status: "done", id: "01PHOTO" }) });
    expect(deserializeGiveDraft(serializeGiveDraft(state))?.photos[0]?.status).toBe("done");
  });

  // Guard validated by breaking it: removing the `isCategory` narrowing in
  // `deserializeGiveDraft` (i.e. spreading `...parsed` over
  // `GIVE_DRAFT_INITIAL` unconditionally, the way every other field works)
  // made this test fail — `rehydrated?.category` came back `null`, not
  // `"other"` — since `JSON.parse` preserves a legacy draft's literal
  // `null`. Restored afterward.
  it("GUARD: normalizes a pre-#35 draft's category:null to the current default rather than letting it ride through", () => {
    const legacyRaw = JSON.stringify({ ...GIVE_DRAFT_INITIAL, category: null });
    const rehydrated = deserializeGiveDraft(legacyRaw);
    expect(rehydrated?.category).toBe("other");
  });

  it("keeps a valid persisted category as-is", () => {
    const raw = JSON.stringify({ ...GIVE_DRAFT_INITIAL, category: "jewelry_watches" });
    const rehydrated = deserializeGiveDraft(raw);
    expect(rehydrated?.category).toBe("jewelry_watches");
  });
});

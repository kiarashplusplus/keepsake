import { GIVE_DRAFT_INITIAL, deserializeGiveDraft, giveDraftReducer, serializeGiveDraft, type GiveDraftPhoto } from "@/features/give/giveDraft";

function photo(clientId: string): GiveDraftPhoto {
  return { clientId, id: null, objectUrl: null, width: 100, height: 100, blurhash: "abc", status: "uploading", error: null };
}

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
    state = giveDraftReducer(state, { type: "set_category", category: "home_kitchen" });
    state = giveDraftReducer(state, { type: "set_country", country: "CA" });
    state = giveDraftReducer(state, { type: "set_postal_code", postalCode: "M5V" });
    state = giveDraftReducer(state, { type: "set_email", email: "a@b.com" });
    state = giveDraftReducer(state, { type: "set_listing_id", listingId: "01LISTING" });

    expect(state).toMatchObject({
      title: "A mug",
      story: "A".repeat(30),
      category: "home_kitchen",
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
});

import { renderHook } from "@testing-library/react-native";
import { draftPhotoSource, useDraftPhotoSource } from "@/features/give/photoSource";
import { getOwnerToken } from "@/lib/ownerToken";

jest.mock("@/lib/ownerToken", () => ({
  getOwnerToken: jest.fn(),
}));

jest.mock("@/lib/config", () => ({
  config: { siteUrl: "https://keepsake.test" },
}));

const OWNER_TOKEN = "ks_" + "a".repeat(43);

describe("draftPhotoSource", () => {
  beforeEach(() => {
    jest.mocked(getOwnerToken).mockReset();
    jest.mocked(getOwnerToken).mockReturnValue(OWNER_TOKEN);
  });

  it("prefers this session's object URL, with no request at all", () => {
    expect(draftPhotoSource({ id: "01PHOTO", objectUrl: "blob:http://localhost/x" })).toEqual({
      uri: "blob:http://localhost/x",
    });
  });

  // The rung a resumed draft lands on. Before it existed, a tile that came
  // back from `sessionStorage` had nothing to load and showed its blurhash
  // alone — a smear the giver could not tell from a stuck upload.
  it("falls back to the owner-authed thumb route once the object URL is gone", () => {
    expect(draftPhotoSource({ id: "01PHOTO", objectUrl: null })).toEqual({
      uri: "https://keepsake.test/i/01PHOTO/thumb",
      headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
    });
  });

  it("sends the thumb route unauthenticated only when there is no token to send", () => {
    jest.mocked(getOwnerToken).mockReturnValue(null);
    expect(draftPhotoSource({ id: "01PHOTO", objectUrl: null })).toEqual({
      uri: "https://keepsake.test/i/01PHOTO/thumb",
    });
  });

  it("has nothing to load for a photo that never got an id", () => {
    expect(draftPhotoSource({ id: null, objectUrl: null })).toBeNull();
    expect(draftPhotoSource(null)).toBeNull();
  });
});

describe("useDraftPhotoSource", () => {
  beforeEach(() => {
    jest.mocked(getOwnerToken).mockReturnValue(OWNER_TOKEN);
  });

  // `expo-image`'s web `useHeaders` refetches on every change of `source`
  // identity, so a fresh object per render is a thumb download per render.
  it("hands back the same source object across re-renders with the same photo fields", () => {
    const { result, rerender } = renderHook(
      (photo: { id: string | null; objectUrl: string | null }) => useDraftPhotoSource(photo),
      {
        initialProps: { id: "01PHOTO", objectUrl: null },
      },
    );
    const first = result.current;
    expect(first).toEqual({
      uri: "https://keepsake.test/i/01PHOTO/thumb",
      headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
    });

    // A new photo object, same fields — what every parent re-render produces.
    rerender({ id: "01PHOTO", objectUrl: null });
    expect(result.current).toBe(first);

    rerender({ id: "01PHOTO", objectUrl: "blob:http://localhost/x" });
    expect(result.current).toEqual({ uri: "blob:http://localhost/x" });
  });
});

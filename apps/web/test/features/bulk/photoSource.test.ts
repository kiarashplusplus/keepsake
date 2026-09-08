import { renderHook } from "@testing-library/react-native";
import { bulkPhotoSource, useBulkPhotoSource } from "@/features/bulk/photoSource";
import { getOwnerToken } from "@/lib/ownerToken";

jest.mock("@/lib/ownerToken", () => ({
  getOwnerToken: jest.fn(),
}));

jest.mock("@/lib/config", () => ({
  config: { siteUrl: "https://keepsake.test" },
}));

const OWNER_TOKEN = "ks_" + "a".repeat(43);

describe("bulkPhotoSource", () => {
  beforeEach(() => {
    jest.mocked(getOwnerToken).mockReset();
    jest.mocked(getOwnerToken).mockReturnValue(OWNER_TOKEN);
  });

  it("prefers this session's local preview, with no request at all", () => {
    expect(bulkPhotoSource({ localPreviewUrl: "blob:http://localhost/x", urlThumb: "https://keepsake.test/i/1/thumb" })).toEqual({
      uri: "blob:http://localhost/x",
    });
  });

  it("falls back to the owner-authed thumb URL once the local preview is gone — the case after a reload", () => {
    expect(bulkPhotoSource({ localPreviewUrl: null, urlThumb: "https://keepsake.test/i/01PHOTO/thumb" })).toEqual({
      uri: "https://keepsake.test/i/01PHOTO/thumb",
      headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
    });
  });

  it("sends the thumb route unauthenticated only when there is no token to send", () => {
    jest.mocked(getOwnerToken).mockReturnValue(null);
    expect(bulkPhotoSource({ localPreviewUrl: null, urlThumb: "https://keepsake.test/i/01PHOTO/thumb" })).toEqual({
      uri: "https://keepsake.test/i/01PHOTO/thumb",
    });
  });

  it("has nothing to load for a photo that hasn't synced and has no local preview", () => {
    expect(bulkPhotoSource({ localPreviewUrl: null, urlThumb: null })).toBeNull();
    expect(bulkPhotoSource(null)).toBeNull();
  });
});

describe("useBulkPhotoSource", () => {
  beforeEach(() => {
    jest.mocked(getOwnerToken).mockReturnValue(OWNER_TOKEN);
  });

  it("hands back the same source object across re-renders with the same photo fields", () => {
    const { result, rerender } = renderHook(
      (photo: { localPreviewUrl: string | null; urlThumb: string | null }) => useBulkPhotoSource(photo),
      { initialProps: { localPreviewUrl: null, urlThumb: "https://keepsake.test/i/01PHOTO/thumb" } },
    );
    const first = result.current;
    expect(first).toEqual({ uri: "https://keepsake.test/i/01PHOTO/thumb", headers: { Authorization: `Bearer ${OWNER_TOKEN}` } });

    rerender({ localPreviewUrl: null, urlThumb: "https://keepsake.test/i/01PHOTO/thumb" });
    expect(result.current).toBe(first);
  });

  // At up to 300 photos, a virtualized list must be able to defer resolving
  // (and therefore fetching) an off-screen tile's authenticated thumb URL —
  // this is the whole reason `enabled` exists.
  it("resolves to null while disabled, even with a urlThumb ready to use", () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useBulkPhotoSource({ localPreviewUrl: null, urlThumb: "https://keepsake.test/i/01PHOTO/thumb" }, enabled),
      { initialProps: { enabled: false } },
    );
    expect(result.current).toBeNull();

    rerender({ enabled: true });
    expect(result.current).toEqual({ uri: "https://keepsake.test/i/01PHOTO/thumb", headers: { Authorization: `Bearer ${OWNER_TOKEN}` } });
  });
});

import { fixPhotoUrls } from "@/api/fixPhotoUrls";

describe("fixPhotoUrls", () => {
  it("resolves a relative url_full/url_thumb on a bare photo", () => {
    const result = fixPhotoUrls({ id: "p1", url_full: "/i/p1/full", url_thumb: "/i/p1/thumb" }) as Record<string, unknown>;
    expect(result.url_full).toMatch(/^https?:\/\/.+\/i\/p1\/full$/);
    expect(result.url_thumb).toMatch(/^https?:\/\/.+\/i\/p1\/thumb$/);
  });

  it("leaves an already-absolute URL untouched", () => {
    const result = fixPhotoUrls({ url_full: "https://cdn.example.com/i/p1/full" }) as Record<string, unknown>;
    expect(result.url_full).toBe("https://cdn.example.com/i/p1/full");
  });

  it("fixes photos nested inside a listing", () => {
    const result = fixPhotoUrls({ id: "l1", photos: [{ id: "p1", url_full: "/i/p1/full", url_thumb: "/i/p1/thumb" }] }) as {
      photos: Record<string, unknown>[];
    };
    expect(result.photos[0]?.url_full).toMatch(/^https?:\/\//);
  });

  it("fixes photos nested inside a feed page's items", () => {
    const result = fixPhotoUrls({
      items: [{ id: "l1", photos: [{ id: "p1", url_full: "/i/p1/full", url_thumb: "/i/p1/thumb" }] }],
      next_cursor: null,
    }) as { items: { photos: Record<string, unknown>[] }[] };
    expect(result.items[0]?.photos[0]?.url_full).toMatch(/^https?:\/\//);
  });

  it("fixes photos inside a bare array of listings", () => {
    const result = fixPhotoUrls([{ id: "l1", photos: [{ id: "p1", url_thumb: "/i/p1/thumb" }] }]) as {
      photos: Record<string, unknown>[];
    }[];
    expect(result[0]?.photos[0]?.url_thumb).toMatch(/^https?:\/\//);
  });

  it("passes through non-object/null values unchanged", () => {
    expect(fixPhotoUrls(null)).toBeNull();
    expect(fixPhotoUrls("hello")).toBe("hello");
  });
});

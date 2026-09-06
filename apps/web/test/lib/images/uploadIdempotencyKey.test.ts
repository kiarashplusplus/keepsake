import { uploadIdempotencyKey } from "@/lib/images/uploadIdempotencyKey";

describe("uploadIdempotencyKey", () => {
  const base = { name: "photo.jpg", size: 12345, lastModified: 1690000000000 };

  it("is deterministic for the same file identity", () => {
    expect(uploadIdempotencyKey(base)).toBe(uploadIdempotencyKey({ ...base }));
  });

  it("changes when the size differs", () => {
    expect(uploadIdempotencyKey({ ...base, size: base.size + 1 })).not.toBe(uploadIdempotencyKey(base));
  });

  it("changes when the name differs", () => {
    expect(uploadIdempotencyKey({ ...base, name: "other.jpg" })).not.toBe(uploadIdempotencyKey(base));
  });

  it("changes when lastModified differs", () => {
    expect(uploadIdempotencyKey({ ...base, lastModified: base.lastModified + 1 })).not.toBe(uploadIdempotencyKey(base));
  });

  it("always returns an 8-character lowercase hex string", () => {
    expect(uploadIdempotencyKey(base)).toMatch(/^[0-9a-f]{8}$/);
  });
});

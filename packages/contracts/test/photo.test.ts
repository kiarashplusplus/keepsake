import { describe, expect, it } from "vitest";
import { MAX_PHOTO_BYTES, MAX_PHOTOS, UploadPhotoFields } from "../src/photo";

describe("UploadPhotoFields", () => {
  it("accepts a valid field set", () => {
    const result = UploadPhotoFields.safeParse({ width: 2048, height: 1536, blurhash: "LKO2?U%2Tw=w]~RBVZRi};RPxuwH" });
    expect(result.success).toBe(true);
  });

  it("rejects width of 0", () => {
    expect(UploadPhotoFields.safeParse({ width: 0, height: 100, blurhash: "abcdef" }).success).toBe(false);
  });

  it("rejects width over 8192", () => {
    expect(UploadPhotoFields.safeParse({ width: 8193, height: 100, blurhash: "abcdef" }).success).toBe(false);
  });

  it("rejects a too-short blurhash", () => {
    expect(UploadPhotoFields.safeParse({ width: 100, height: 100, blurhash: "abc" }).success).toBe(false);
  });
});

describe("constants", () => {
  it("caps photos at 5 and bytes at 5 MiB", () => {
    expect(MAX_PHOTOS).toBe(5);
    expect(MAX_PHOTO_BYTES).toBe(5 * 1024 * 1024);
  });
});

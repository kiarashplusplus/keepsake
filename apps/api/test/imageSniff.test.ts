import { describe, expect, it } from "vitest";
import { sniffImageType, extensionForSniffedType } from "../src/lib/imageSniff.js";

describe("sniffImageType", () => {
  it("recognizes a JPEG by its FF D8 FF magic bytes", () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("image/jpeg");
  });

  it("recognizes a PNG by its 89 50 4E 47 magic bytes", () => {
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe("image/png");
  });

  it("recognizes a WebP by its RIFF....WEBP magic bytes", () => {
    const bytes = new Uint8Array(16);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    bytes.set([0, 0, 0, 0], 4); // chunk size, irrelevant to sniffing
    bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
    expect(sniffImageType(bytes)).toBe("image/webp");
  });

  it("rejects bytes that don't match any known magic number", () => {
    expect(sniffImageType(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull(); // %PDF
    expect(sniffImageType(new Uint8Array([]))).toBeNull();
  });

  // Guard validated by breaking it: temporarily requiring a 4th JPEG byte to
  // match (e.g. `bytes[3] === 0xe0`) makes this fail against a real minimal
  // JPEG buffer like `[0xff, 0xd8, 0xff, 0xdb, ...]`, proving the test
  // actually exercises the 3-byte JPEG rule rather than a fixture that only
  // ever provides `0xe0` in that position.
  it("only requires the first 3 JPEG bytes, not a specific 4th marker byte", () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 1, 2]))).toBe("image/jpeg");
  });
});

describe("extensionForSniffedType", () => {
  it("maps each sniffed type to its file extension", () => {
    expect(extensionForSniffedType("image/jpeg")).toBe("jpg");
    expect(extensionForSniffedType("image/png")).toBe("png");
    expect(extensionForSniffedType("image/webp")).toBe("webp");
  });
});

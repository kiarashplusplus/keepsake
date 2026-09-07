import { describe, expect, it } from "vitest";
import { sniffImageDimensions, sniffImageType, extensionForSniffedType } from "../src/lib/imageSniff.js";
import { fakeJpegBytes, fakeJpegWithSof, fakePngBytes } from "./helpers.js";

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

describe("sniffImageDimensions", () => {
  it("reads a JPEG's SOF0 past a preceding APP0 segment", () => {
    // The marker walk is the point: a fixed-offset read would find the JFIF
    // segment here, which is what every real camera JPEG puts first.
    expect(sniffImageDimensions(fakeJpegWithSof(4032, 3024))).toEqual({ width: 4032, height: 3024 });
  });

  it("reads a PNG's IHDR", () => {
    expect(sniffImageDimensions(fakePngBytes(1200, 900))).toEqual({ width: 1200, height: 900 });
  });

  it("reads a lossy WebP's VP8 frame header", () => {
    const bytes = new Uint8Array(32);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
    bytes.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
    bytes.set([0x56, 0x50, 0x38, 0x20], 12); // "VP8 "
    bytes.set([0x40, 0x01], 26); // width 320
    bytes.set([0xf0, 0x00], 28); // height 240
    expect(sniffImageDimensions(bytes)).toEqual({ width: 320, height: 240 });
  });

  it("reads an extended WebP's VP8X canvas size", () => {
    const bytes = new Uint8Array(40);
    bytes.set([0x52, 0x49, 0x46, 0x46], 0);
    bytes.set([0x57, 0x45, 0x42, 0x50], 8);
    bytes.set([0x56, 0x50, 0x38, 0x58], 12); // "VP8X"
    // Stored one less than the true value, 24-bit little-endian.
    bytes.set([0x3f, 0x01, 0x00], 24); // width 320
    bytes.set([0xef, 0x00, 0x00], 27); // height 240
    expect(sniffImageDimensions(bytes)).toEqual({ width: 320, height: 240 });
  });

  // `null` is the fail-open answer the route depends on: it falls back to the
  // client's declared values rather than refusing an upload over a parser gap.
  it("returns null for a JPEG with no readable frame header", () => {
    expect(sniffImageDimensions(fakeJpegBytes())).toBeNull();
  });

  it("returns null for a JPEG truncated before its SOF", () => {
    expect(sniffImageDimensions(fakeJpegWithSof(800, 600).subarray(0, 12))).toBeNull();
  });

  it("returns null rather than spinning on a file that is nothing but markers", () => {
    // Every segment declares the minimum length and none is an SOF, so a walk
    // without a bound would step forever.
    const bytes = new Uint8Array(4096);
    bytes[0] = 0xff;
    bytes[1] = 0xd8;
    for (let offset = 2; offset + 3 < bytes.length; offset += 4) {
      bytes[offset] = 0xff;
      bytes[offset + 1] = 0xe1;
      bytes[offset + 2] = 0x00;
      bytes[offset + 3] = 0x02;
    }
    expect(sniffImageDimensions(bytes)).toBeNull();
  });

  it("returns null for bytes that aren't an image at all", () => {
    expect(sniffImageDimensions(new TextEncoder().encode("definitely not an image"))).toBeNull();
  });
});

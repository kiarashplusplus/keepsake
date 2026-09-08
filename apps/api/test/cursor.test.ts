import { describe, expect, it } from "vitest";
import {
  decodeKeysetCursor,
  decodeOffsetCursor,
  encodeBase64Url,
  encodeKeysetCursor,
  encodeOffsetCursor,
} from "../src/lib/cursor.js";

describe("pagination cursors", () => {
  it("round-trips valid keyset and offset cursors", () => {
    expect(decodeKeysetCursor(encodeKeysetCursor(1_725_000_000_000, "01J4TEST"))).toEqual({
      publishedAt: 1_725_000_000_000,
      id: "01J4TEST",
    });
    expect(decodeOffsetCursor(encodeOffsetCursor(24))).toBe(24);
  });

  it.each(["12items", "1.5", "+12", " 12", "12 ", "1e2"])(
    "rejects a partly numeric offset cursor (%s)",
    (value) => {
      expect(decodeOffsetCursor(encodeBase64Url(value))).toBe(0);
    },
  );

  it.each(["1725000000000ms:01J4TEST", "1.5:01J4TEST", "+12:01J4TEST", " 12:01J4TEST"])(
    "rejects a partly numeric keyset timestamp (%s)",
    (value) => {
      expect(decodeKeysetCursor(encodeBase64Url(value))).toBeNull();
    },
  );

  it("rejects integers that cannot be represented safely", () => {
    expect(decodeOffsetCursor(encodeBase64Url("9007199254740993"))).toBe(0);
    expect(decodeKeysetCursor(encodeBase64Url("9007199254740993:01J4TEST"))).toBeNull();
  });
});

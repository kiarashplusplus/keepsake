import { describe, expect, it } from "vitest";
import { isOwnerToken, OwnerTokenSchema } from "../src/owner";

const validToken = `ks_${"a".repeat(43)}`;

describe("OwnerTokenSchema", () => {
  it("accepts the ks_ prefix plus 43 base64url chars", () => {
    expect(OwnerTokenSchema.safeParse(validToken).success).toBe(true);
  });

  it("rejects a missing prefix", () => {
    expect(OwnerTokenSchema.safeParse("a".repeat(46)).success).toBe(false);
  });

  it("rejects the wrong length", () => {
    expect(OwnerTokenSchema.safeParse("ks_tooshort").success).toBe(false);
  });

  it("rejects characters outside base64url", () => {
    expect(OwnerTokenSchema.safeParse(`ks_${"a".repeat(42)}!`).success).toBe(false);
  });
});

describe("isOwnerToken", () => {
  it("narrows a valid token", () => {
    expect(isOwnerToken(validToken)).toBe(true);
  });

  it("rejects non-strings and invalid strings", () => {
    expect(isOwnerToken(123)).toBe(false);
    expect(isOwnerToken("not-a-token")).toBe(false);
  });
});

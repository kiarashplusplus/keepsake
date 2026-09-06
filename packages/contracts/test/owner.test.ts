import { describe, expect, it } from "vitest";
import { RESERVED_EMAIL_DOMAIN_MESSAGE } from "../src/common";
import { isOwnerToken, OwnerTokenSchema, RecoverInput, SetEmailInput } from "../src/owner";

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

describe("SetEmailInput", () => {
  it("accepts a normal address", () => {
    expect(SetEmailInput.safeParse({ email: "owner@keepsake.ing" }).success).toBe(true);
  });

  it.each(["me@example.com", "x@foo.test"])("rejects a reserved-domain address (%s) with a friendly message", (email) => {
    const result = SetEmailInput.safeParse({ email });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(RESERVED_EMAIL_DOMAIN_MESSAGE);
    }
  });
});

describe("RecoverInput", () => {
  it("accepts a normal address", () => {
    expect(RecoverInput.safeParse({ email: "owner@keepsake.ing" }).success).toBe(true);
  });

  it.each(["me@example.com", "x@foo.test"])("rejects a reserved-domain address (%s) with a friendly message", (email) => {
    const result = RecoverInput.safeParse({ email });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(RESERVED_EMAIL_DOMAIN_MESSAGE);
    }
  });
});

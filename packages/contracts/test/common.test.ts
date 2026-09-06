import { describe, expect, it } from "vitest";
import { apiErr, apiOk, EmailSchema, PaginationLimitSchema, UlidSchema } from "../src/common";

describe("apiOk / apiErr", () => {
  it("wraps success payloads", () => {
    expect(apiOk({ hello: "world" })).toEqual({ ok: true, data: { hello: "world" } });
  });

  it("wraps errors without retryAfter when omitted", () => {
    const err = apiErr("not_found", "no such listing");
    expect(err).toEqual({ ok: false, error: { code: "not_found", message: "no such listing" } });
    expect("retryAfter" in err.error).toBe(false);
  });

  it("includes retryAfter when provided", () => {
    const err = apiErr("rate_limited", "slow down", 30);
    expect(err.error.retryAfter).toBe(30);
  });
});

describe("UlidSchema", () => {
  it("accepts a canonical ULID", () => {
    expect(UlidSchema.safeParse("01ARZ3NDEKTSV4RRFFQ69G5FAV").success).toBe(true);
  });

  it("rejects ambiguous Crockford characters (I, L, O, U)", () => {
    expect(UlidSchema.safeParse("01ARZ3NDEKTSV4RRFFQ69G5FAI").success).toBe(false);
  });

  it("rejects the wrong length", () => {
    expect(UlidSchema.safeParse("01ARZ3ND").success).toBe(false);
  });
});

describe("EmailSchema", () => {
  it("lowercases and trims", () => {
    expect(EmailSchema.parse("  Jane.Doe@Example.COM  ")).toBe("jane.doe@example.com");
  });

  it("rejects malformed addresses", () => {
    expect(EmailSchema.safeParse("not-an-email").success).toBe(false);
  });
});

describe("PaginationLimitSchema", () => {
  it("defaults to 24", () => {
    expect(PaginationLimitSchema.parse(undefined)).toBe(24);
  });

  it("rejects over 48", () => {
    expect(PaginationLimitSchema.safeParse(49).success).toBe(false);
  });

  it("coerces query-string numbers", () => {
    expect(PaginationLimitSchema.parse("10")).toBe(10);
  });
});

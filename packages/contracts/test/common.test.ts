import { describe, expect, it } from "vitest";
import {
  AgeAttestationSchema,
  apiErr,
  apiOk,
  EmailSchema,
  isReservedEmailDomain,
  MailableEmailSchema,
  MINIMUM_AGE,
  PaginationLimitSchema,
  RESERVED_EMAIL_DOMAIN_MESSAGE,
  UlidSchema,
} from "../src/common";

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

  it("stays permissive for reserved domains — the fixture-friendly base schema", () => {
    // Plenty of other schemas' outputs (`OwnerMe.email`, `OwnerViewRequest.email`)
    // echo an address back rather than send to it; `MailableEmailSchema` below
    // is the one that guards actual sends.
    expect(EmailSchema.safeParse("nobody@example.com").success).toBe(true);
  });
});

describe("isReservedEmailDomain", () => {
  it("flags the reserved TLDs and RFC 2606 domains", () => {
    for (const address of [
      "someone@example.com",
      "a@example.net",
      "b@example.org",
      "c@example.edu",
      "d@anything.test",
      "e@thing.invalid",
      "f@dev.localhost",
      "g@dev.local",
      "h@sub.example",
    ]) {
      expect(isReservedEmailDomain(address), address).toBe(true);
    }
  });

  it("is case-insensitive", () => {
    expect(isReservedEmailDomain("Someone@EXAMPLE.COM")).toBe(true);
  });

  it("ignores surrounding whitespace", () => {
    expect(isReservedEmailDomain("  someone@example.com  ")).toBe(true);
  });

  it("does not flag a normal address", () => {
    expect(isReservedEmailDomain("someone@keepsake.ing")).toBe(false);
    expect(isReservedEmailDomain("someone@gmail.com")).toBe(false);
  });

  it("treats an address with no domain as reserved", () => {
    expect(isReservedEmailDomain("no-at-sign")).toBe(true);
  });
});

describe("MailableEmailSchema", () => {
  it("accepts a normal address", () => {
    expect(MailableEmailSchema.safeParse("someone@keepsake.ing").success).toBe(true);
  });

  it.each(["me@example.com", "x@foo.test"])("rejects a reserved-domain address (%s) with a friendly message", (email) => {
    const result = MailableEmailSchema.safeParse(email);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(RESERVED_EMAIL_DOMAIN_MESSAGE);
    }
  });

  it("still rejects malformed addresses", () => {
    expect(MailableEmailSchema.safeParse("not-an-email").success).toBe(false);
  });
});

describe("AgeAttestationSchema (minimum age, docs/legal-considerations.md)", () => {
  it("accepts true", () => {
    expect(AgeAttestationSchema.safeParse(true).success).toBe(true);
  });

  it("rejects false — merely present-and-false must not pass", () => {
    expect(AgeAttestationSchema.safeParse(false).success).toBe(false);
  });

  it("rejects undefined", () => {
    expect(AgeAttestationSchema.safeParse(undefined).success).toBe(false);
  });

  it("MINIMUM_AGE is 18, higher than COPPA's 13 — the product arranges in-person meetups with strangers", () => {
    expect(MINIMUM_AGE).toBe(18);
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

import { describe, expect, it } from "vitest";
import {
  apiErr,
  apiOk,
  calculateAge,
  DateOfBirthSchema,
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

describe("calculateAge (issue #64)", () => {
  const reference = new Date(Date.UTC(2026, 5, 15)); // 2026-06-15

  it("counts a birthday that already happened this year", () => {
    expect(calculateAge("2000-01-01", reference)).toBe(26);
  });

  it("doesn't count a birthday that hasn't happened yet this year", () => {
    expect(calculateAge("2000-12-31", reference)).toBe(25);
  });

  it("counts a birthday that is exactly today as already happened", () => {
    expect(calculateAge("2000-06-15", reference)).toBe(26);
  });

  it("handles a leap-day birthday against a non-leap reference year", () => {
    // Feb 29 born; by June of a later year the birthday has already passed
    // regardless of whether that later year itself is a leap year.
    expect(calculateAge("2000-02-29", reference)).toBe(26);
  });

  it("is one day short of 18 the day before an 18th birthday — a deterministic stand-in for DateOfBirthSchema's real-clock boundary", () => {
    // Pinned to a fixed instant rather than derived from the real clock, or
    // this would flip pass/fail depending on which day of the year it ran.
    expect(calculateAge("2008-06-16", reference)).toBe(17);
    expect(calculateAge("2008-06-15", reference)).toBe(18);
  });
});

describe("DateOfBirthSchema (minimum age, docs/legal-considerations.md, issue #64)", () => {
  it("accepts a date of birth well over the minimum age", () => {
    expect(DateOfBirthSchema.safeParse("1990-01-01").success).toBe(true);
  });

  it("rejects a date of birth under the minimum age", () => {
    const result = DateOfBirthSchema.safeParse("2020-01-01");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(`You must be ${MINIMUM_AGE} or older to continue.`);
    }
  });

  it("rejects undefined", () => {
    expect(DateOfBirthSchema.safeParse(undefined).success).toBe(false);
  });

  it("rejects a malformed date string", () => {
    expect(DateOfBirthSchema.safeParse("01/01/1990").success).toBe(false);
  });

  it("rejects a calendar date that doesn't exist (Date.parse would silently roll this over to March 1st)", () => {
    const result = DateOfBirthSchema.safeParse("2024-02-30");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe("That's not a real date.");
    }
  });

  it("rejects a date of birth in the future", () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(DateOfBirthSchema.safeParse(future).success).toBe(false);
  });

  it("rejects an implausibly old date of birth", () => {
    expect(DateOfBirthSchema.safeParse("1800-01-01").success).toBe(false);
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

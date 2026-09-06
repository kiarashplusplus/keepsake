import { describe, expect, it } from "vitest";
import { RESERVED_EMAIL_DOMAIN_MESSAGE } from "../src/common";
import { CreateRequestInput, maskEmail, maskPhone } from "../src/request";

describe("maskEmail", () => {
  it("keeps the first char and the domain", () => {
    expect(maskEmail("jane.doe@example.com")).toBe("j•••@example.com");
  });
});

describe("maskPhone", () => {
  it("keeps the last two digits and the leading +", () => {
    // "16175550134" is 11 digits; 9 masked + the last 2 visible.
    expect(maskPhone("+16175550134")).toBe("+•••••••••34");
  });

  it("keeps the last two digits without a +", () => {
    expect(maskPhone("6175550134")).toBe("••••••••34");
  });
});

describe("CreateRequestInput", () => {
  it("accepts a well-formed request", () => {
    const result = CreateRequestInput.safeParse({
      note: "I would love to give this a new home.",
      email: "friend@keepsake.ing",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a note under 10 chars", () => {
    expect(CreateRequestInput.safeParse({ note: "hi", email: "friend@keepsake.ing" }).success).toBe(false);
  });

  it("rejects a malformed phone", () => {
    const result = CreateRequestInput.safeParse({
      note: "I would love to give this a new home.",
      email: "friend@keepsake.ing",
      phone: "call-me-maybe",
    });
    expect(result.success).toBe(false);
  });

  it.each(["me@example.com", "x@foo.test"])("rejects a reserved-domain email (%s) with a friendly message", (email) => {
    const result = CreateRequestInput.safeParse({
      note: "I would love to give this a new home.",
      email,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(RESERVED_EMAIL_DOMAIN_MESSAGE);
    }
  });
});

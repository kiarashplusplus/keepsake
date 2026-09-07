import { describe, expect, it } from "vitest";
import { RESERVED_EMAIL_DOMAIN_MESSAGE } from "../src/common";
import { CreateListingInput, MODERATION_REASONS } from "../src/listing";

const validPhotoIds = ["01ARZ3NDEKTSV4RRFFQ69G5FAV"];

function validInput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    title: "Grandmother's teacup",
    story: "This has been in the family for three generations and I want it to find a new home.",
    category: "home_kitchen",
    country: "US",
    postal_code: "02144",
    photo_ids: validPhotoIds,
    date_of_birth: "1990-01-01",
    ...overrides,
  };
}

describe("CreateListingInput", () => {
  it("accepts a well-formed listing", () => {
    expect(CreateListingInput.safeParse(validInput()).success).toBe(true);
  });

  it("rejects a 3-character title", () => {
    const result = CreateListingInput.safeParse(validInput({ title: "Cup" }));
    expect(result.success).toBe(false);
  });

  it("rejects 6 photo ids (max is 5)", () => {
    const sixPhotos = Array.from({ length: 6 }, () => validPhotoIds[0]);
    const result = CreateListingInput.safeParse(validInput({ photo_ids: sixPhotos }));
    expect(result.success).toBe(false);
  });

  it("rejects a story under 20 chars", () => {
    const result = CreateListingInput.safeParse(validInput({ story: "too short" }));
    expect(result.success).toBe(false);
  });

  it("accepts an optional, well-formed email", () => {
    expect(CreateListingInput.safeParse(validInput({ email: "owner@keepsake.ing" })).success).toBe(true);
  });

  it.each(["me@example.com", "x@foo.test"])("rejects a reserved-domain email (%s) with a friendly message", (email) => {
    const result = CreateListingInput.safeParse(validInput({ email }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(RESERVED_EMAIL_DOMAIN_MESSAGE);
    }
  });

  it("rejects a missing date of birth (docs/legal-considerations.md Minimum age, issue #64)", () => {
    const { date_of_birth: _omit, ...withoutAttestation } = validInput();
    const result = CreateListingInput.safeParse(withoutAttestation);
    expect(result.success).toBe(false);
  });

  it("rejects a date of birth under the minimum age", () => {
    const result = CreateListingInput.safeParse(validInput({ date_of_birth: "2020-01-01" }));
    expect(result.success).toBe(false);
  });

  it("no longer accepts GB as a country — see the UK geo-block, docs/runbooks/uk-block.md", () => {
    const result = CreateListingInput.safeParse(validInput({ country: "GB" }));
    expect(result.success).toBe(false);
  });

  // Issue #20: the title gets interpolated straight into email subject
  // headers (apps/api/src/email/templates/newRequest.ts/chosen.ts), which
  // are never HTML-escaped — a raw newline there could inject extra header
  // lines. This is the schema-level half of the fix; `sanitizeSubject`
  // (apps/api/src/email/templates/shared.ts) is the runtime backstop.
  it.each([
    ["a bare \\n", "Grandmother's\nteacup"],
    ["a bare \\r", "Grandmother's\rteacup"],
    ["a \\r\\n pair", "Grandmother's\r\nteacup"],
  ])("rejects a title containing %s", (_label, title) => {
    const result = CreateListingInput.safeParse(validInput({ title }));
    expect(result.success).toBe(false);
  });

  it("still accepts a title with ordinary punctuation", () => {
    expect(CreateListingInput.safeParse(validInput({ title: "Grandmother's teacup — chipped, but loved" })).success).toBe(true);
  });
});

describe("MODERATION_REASONS", () => {
  it("has giver-facing copy for contact_in_story", () => {
    expect(MODERATION_REASONS.contact_in_story).toMatch(/contact details/i);
  });

  it("has copy for every reason code", () => {
    for (const value of Object.values(MODERATION_REASONS)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });
});

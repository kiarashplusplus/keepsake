import { describe, expect, it } from "vitest";
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

import { describe, expect, it } from "vitest";
import { MAX_PHOTOS, PhotoSuggestionSchema, UploadPhotoFields } from "../src/photo";

describe("UploadPhotoFields", () => {
  it("accepts a valid field set", () => {
    const result = UploadPhotoFields.safeParse({ width: 2048, height: 1536, blurhash: "LKO2?U%2Tw=w]~RBVZRi};RPxuwH" });
    expect(result.success).toBe(true);
  });

  it("rejects width of 0", () => {
    expect(UploadPhotoFields.safeParse({ width: 0, height: 100, blurhash: "abcdef" }).success).toBe(false);
  });

  it("rejects width over 8192", () => {
    expect(UploadPhotoFields.safeParse({ width: 8193, height: 100, blurhash: "abcdef" }).success).toBe(false);
  });

  it("rejects a too-short blurhash", () => {
    expect(UploadPhotoFields.safeParse({ width: 100, height: 100, blurhash: "abc" }).success).toBe(false);
  });
});

describe("constants", () => {
  it("caps photos at 5", () => {
    expect(MAX_PHOTOS).toBe(5);
  });
});

function validSuggestion(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    subject: "a chipped stoneware mug",
    markings: "",
    title: "Chipped stoneware mug",
    category: "home_kitchen",
    condition: "glaze worn at the rim",
    ...overrides,
  };
}

describe("PhotoSuggestionSchema", () => {
  it("accepts a well-formed suggestion", () => {
    const result = PhotoSuggestionSchema.safeParse(validSuggestion());
    expect(result.success).toBe(true);
  });

  it("trims whitespace on every string field", () => {
    const result = PhotoSuggestionSchema.safeParse(
      validSuggestion({ subject: "  mug  ", title: "  Chipped mug  ", condition: "  worn  " }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.subject).toBe("mug");
      expect(result.data.title).toBe("Chipped mug");
      expect(result.data.condition).toBe("worn");
    }
  });

  it("allows an empty condition (nothing notable)", () => {
    expect(PhotoSuggestionSchema.safeParse(validSuggestion({ condition: "" })).success).toBe(true);
  });

  // Guard validated by breaking it: loosening `category` to a bare
  // `z.string()` in src/photo.ts makes this test fail, since a hallucinated
  // category outside the five real ones would then pass through instead of
  // being rejected — confirming the schema (not just the route) is what
  // stops a bad suggestion from producing an unsubmittable form.
  it("rejects a category outside the real CATEGORIES enum", () => {
    const result = PhotoSuggestionSchema.safeParse(validSuggestion({ category: "vintage_collectibles" }));
    expect(result.success).toBe(false);
  });

  it("rejects a title shorter than TITLE_MIN", () => {
    expect(PhotoSuggestionSchema.safeParse(validSuggestion({ title: "Cup" })).success).toBe(false);
  });

  it("rejects a title longer than TITLE_MAX", () => {
    expect(PhotoSuggestionSchema.safeParse(validSuggestion({ title: "x".repeat(81) })).success).toBe(false);
  });

  it("rejects a subject over 120 chars", () => {
    expect(PhotoSuggestionSchema.safeParse(validSuggestion({ subject: "x".repeat(121) })).success).toBe(false);
  });

  it("rejects a condition over 160 chars", () => {
    expect(PhotoSuggestionSchema.safeParse(validSuggestion({ condition: "x".repeat(161) })).success).toBe(false);
  });

  describe("aspects", () => {
    it("defaults to [] when the model reply omits the key entirely", () => {
      const { subject, title, category, condition } = validSuggestion();
      const result = PhotoSuggestionSchema.safeParse({ subject, title, category, condition });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.aspects).toEqual([]);
      }
    });

    it("accepts an explicit empty array", () => {
      const result = PhotoSuggestionSchema.safeParse(validSuggestion({ aspects: [] }));
      expect(result.success).toBe(true);
    });

    it("accepts up to 6 aspects", () => {
      const aspects = Array.from({ length: 6 }, (_, i) => ({ name: `attr${i}`, value: `val${i}` }));
      expect(PhotoSuggestionSchema.safeParse(validSuggestion({ aspects })).success).toBe(true);
    });

    // Guard validated by breaking it: dropping `.max(6)` from `aspects` in
    // src/photo.ts makes this test fail, since a model reply padded with a
    // 7th attribute would then pass through unchanged — confirming the cap
    // is enforced by the schema, not just documented as guidance in the
    // prompt.
    it("rejects more than 6 aspects", () => {
      const aspects = Array.from({ length: 7 }, (_, i) => ({ name: `attr${i}`, value: `val${i}` }));
      expect(PhotoSuggestionSchema.safeParse(validSuggestion({ aspects })).success).toBe(false);
    });

    it("rejects an aspect value over 48 chars", () => {
      const aspects = [{ name: "material", value: "x".repeat(49) }];
      expect(PhotoSuggestionSchema.safeParse(validSuggestion({ aspects })).success).toBe(false);
    });

    it("rejects an aspect name over 24 chars", () => {
      const aspects = [{ name: "x".repeat(25), value: "ceramic" }];
      expect(PhotoSuggestionSchema.safeParse(validSuggestion({ aspects })).success).toBe(false);
    });

    it("rejects an empty aspect value (omit the entry instead of sending a blank)", () => {
      const aspects = [{ name: "material", value: "" }];
      expect(PhotoSuggestionSchema.safeParse(validSuggestion({ aspects })).success).toBe(false);
    });
  });
});

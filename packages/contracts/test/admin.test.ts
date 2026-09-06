import { describe, expect, it } from "vitest";
import { ImageVerdictSchema } from "../src/admin";

const base = {
  is_physical_object: true,
  nsfw: 0.1,
  violence: 0,
  weapons: 0,
  drugs: 0,
  hate_symbols: 0,
  personal_info: 0,
  notes: "looks fine",
};

describe("ImageVerdictSchema", () => {
  it("parses a well-formed verdict", () => {
    const result = ImageVerdictSchema.safeParse(base);
    expect(result.success).toBe(true);
  });

  it("rejects nsfw out of range", () => {
    const result = ImageVerdictSchema.safeParse({ ...base, nsfw: 1.5 });
    expect(result.success).toBe(false);
  });

  it("coerces numeric strings", () => {
    const result = ImageVerdictSchema.safeParse({ ...base, nsfw: "0.4" });
    expect(result.success).toBe(true);
    expect(result.data?.nsfw).toBe(0.4);
  });

  it("ignores unknown extra keys instead of failing", () => {
    const result = ImageVerdictSchema.safeParse({ ...base, extra_commentary: "chatty model" });
    expect(result.success).toBe(true);
  });
});

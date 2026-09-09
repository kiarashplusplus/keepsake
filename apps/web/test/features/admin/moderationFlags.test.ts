import { formatFlagsLine, summarizeFlags } from "@/features/admin/moderationFlags";

/**
 * `flags` is `z.unknown()` on the contract — the pipeline writes whatever it
 * had — so these are the shapes `apps/api/src/moderation/pipeline.ts`
 * actually stores: an image pass's scorecard (with `variant`), a text hit's
 * array of reason codes, a re-moderation downgrade's `{downgraded_from…}`,
 * and nothing at all.
 */
describe("summarizeFlags", () => {
  it("keeps only the non-zero scores, false checks and non-empty strings of an image scorecard", () => {
    const summary = summarizeFlags({
      variant: "thumb",
      is_physical_object: false,
      nsfw: 0,
      violence: 0.7,
      weapons: 0,
      drugs: 0,
      hate_symbols: 0,
      personal_info: 1,
      notes: "",
    });
    expect(summary).toEqual({
      present: true,
      raised: ["variant thumb", "is_physical_object false", "violence 0.7", "personal_info 1"],
    });
  });

  it("reads a clean scorecard as present but with nothing raised", () => {
    const clean = { variant: "full", is_physical_object: true, nsfw: 0, violence: 0, notes: "   " };
    expect(summarizeFlags(clean)).toEqual({ present: true, raised: ["variant full"] });
    expect(formatFlagsLine({ is_physical_object: true, nsfw: 0 })).toBe("nothing raised");
  });

  it("lists a text pass's reason codes as they are", () => {
    expect(formatFlagsLine(["contact_in_story", "not_an_object"])).toBe("contact_in_story · not_an_object");
    expect(summarizeFlags([])).toEqual({ present: false, raised: [] });
  });

  it("names every field of a downgrade marker", () => {
    expect(formatFlagsLine({ downgraded_from: "approved", prior_takedown: "hidden", prior_version: 3 })).toBe(
      "downgraded_from approved · prior_takedown hidden · prior_version 3",
    );
  });

  it("prints nothing for an absent or empty value, and a primitive as itself", () => {
    expect(formatFlagsLine(null)).toBeNull();
    expect(formatFlagsLine(undefined)).toBeNull();
    expect(formatFlagsLine({})).toBeNull();
    expect(formatFlagsLine("budget")).toBe("budget");
  });

  it("falls back to JSON for a nested value rather than \"[object Object]\"", () => {
    expect(formatFlagsLine({ scores: { nsfw: 0.2 } })).toBe('scores {"nsfw":0.2}');
  });
});

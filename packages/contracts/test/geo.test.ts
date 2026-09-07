import { describe, expect, it } from "vitest";
import { boundingBox, COUNTRIES, CountrySchema, haversineMiles, normalizePostalCode } from "../src/geo";

describe("normalizePostalCode", () => {
  it("US: keeps 5 digits, drops +4", () => {
    expect(normalizePostalCode("US", "02144")).toBe("02144");
    expect(normalizePostalCode("US", " 02144-1234 ")).toBe("02144");
  });

  it("US: invalid input returns null", () => {
    expect(normalizePostalCode("US", "abc")).toBeNull();
    expect(normalizePostalCode("US", "")).toBeNull();
  });

  it("CA: first 3 chars uppercased", () => {
    expect(normalizePostalCode("CA", "M5V 3L9")).toBe("M5V");
    expect(normalizePostalCode("CA", "m5v3l9")).toBe("M5V");
  });

  it("CA: invalid input returns null", () => {
    expect(normalizePostalCode("CA", "12345")).toBeNull();
  });

});

describe("COUNTRIES (UK geo-block, docs/runbooks/uk-block.md)", () => {
  it("no longer lists GB", () => {
    expect(COUNTRIES).not.toContain("GB");
    expect(COUNTRIES).toEqual(["US", "CA"]);
  });

  it("CountrySchema rejects GB as a listing/lookup country", () => {
    expect(CountrySchema.safeParse("GB").success).toBe(false);
  });
});

describe("OSA re-entry gate (issue #30)", () => {
  // This is deliberately not folded into the block above: that block checks
  // today's contents of COUNTRIES for whoever's reading the test file. This
  // one exists to fail LOUDLY, with an actionable message, the moment
  // someone re-adds any of these codes — not just report a diff. If this
  // test is red, that is the system working as designed; read the message,
  // don't delete the test.
  const UK_AND_CROWN_DEPENDENCIES = ["GB", "JE", "GG", "IM"] as const;

  it("does not let GB/JE/GG/IM back into COUNTRIES without the OSA re-entry work", () => {
    const reintroduced = UK_AND_CROWN_DEPENDENCIES.filter((code) =>
      (COUNTRIES as readonly string[]).includes(code),
    );

    if (reintroduced.length > 0) {
      throw new Error(
        `${reintroduced.join(", ")} ${reintroduced.length === 1 ? "was" : "were"} added to ` +
          `COUNTRIES, which re-opens Keepsake to UK/Crown Dependency users. Before shipping ` +
          `that, the UK Online Safety Act's illegal-content risk assessment, children's access ` +
          `assessment (already overdue, not schedulable), documented complaints procedure, ` +
          `written record-keeping, and the UK GDPR Article 27 representative question all need ` +
          `to actually be resolved — none of them are optional at any service size. Work ` +
          `through docs/runbooks/uk-reentry-checklist.md before re-adding any of these codes, ` +
          `then update this test (and the matching gate in apps/api/test/ukBlock.test.ts) ` +
          `together with the code change. See also issue #30 and issue #34 (Q1, Q6) on ` +
          `kiarashplusplus/keepsake.`,
      );
    }
  });
});

describe("haversineMiles", () => {
  it("Boston to Cambridge is about 3 miles", () => {
    const boston = { lat: 42.3601, lng: -71.0589 };
    const cambridge = { lat: 42.3736, lng: -71.1097 };
    const miles = haversineMiles(boston, cambridge);
    expect(miles).toBeGreaterThan(2.5);
    expect(miles).toBeLessThan(3.5);
  });

  it("is zero for the same point", () => {
    const p = { lat: 42.3601, lng: -71.0589 };
    expect(haversineMiles(p, p)).toBeCloseTo(0, 6);
  });
});

describe("boundingBox", () => {
  it("centers on the given point and grows with radius", () => {
    const box = boundingBox(42.3601, -71.0589, 25);
    expect(box.minLat).toBeLessThan(42.3601);
    expect(box.maxLat).toBeGreaterThan(42.3601);
    expect(box.minLng).toBeLessThan(-71.0589);
    expect(box.maxLng).toBeGreaterThan(-71.0589);

    const wider = boundingBox(42.3601, -71.0589, 100);
    expect(wider.maxLat - wider.minLat).toBeGreaterThan(box.maxLat - box.minLat);
  });
});

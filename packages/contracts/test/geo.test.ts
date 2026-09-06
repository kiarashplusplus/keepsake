import { describe, expect, it } from "vitest";
import { boundingBox, haversineMiles, normalizePostalCode } from "../src/geo";

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

  it("GB: outward code before the space", () => {
    expect(normalizePostalCode("GB", "sw1a 1aa")).toBe("SW1A");
  });

  it("GB: leading chars when no space is given", () => {
    expect(normalizePostalCode("GB", "ec1a")).toBe("EC1A");
  });

  it("GB: invalid input returns null", () => {
    expect(normalizePostalCode("GB", "!!!!")).toBeNull();
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

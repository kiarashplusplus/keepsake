import {
  DEFAULT_LOCATION_PREF,
  LOCATION_PREF_STORAGE_KEY,
  deserializeLocationPref,
  formatDistance,
  loadLocationPref,
  saveLocationPref,
  serializeLocationPref,
  type LocationPref,
} from "@/lib/geo";

describe("formatDistance", () => {
  it("shows one decimal place under 10 miles", () => {
    expect(formatDistance(2.14)).toBe("2.1 mi");
    expect(formatDistance(0.05)).toBe("0.1 mi");
  });

  it("rounds to whole miles at or above 10", () => {
    expect(formatDistance(12.6)).toBe("13 mi");
    expect(formatDistance(100)).toBe("100 mi");
  });
});

describe("serialize/deserializeLocationPref", () => {
  it("round trips a full preference", () => {
    const pref: LocationPref = { mode: "coords", country: "CA", postal: "", lat: 51.5, lng: -0.1, radius: 50 };
    expect(deserializeLocationPref(serializeLocationPref(pref))).toEqual(pref);
  });

  it("falls back to defaults for malformed JSON", () => {
    expect(deserializeLocationPref("not json")).toBeNull();
  });

  it("falls back field-by-field for an unrecognized radius/country", () => {
    const raw = JSON.stringify({ mode: "postal", country: "FR", postal: "12345", radius: 999 });
    expect(deserializeLocationPref(raw)).toEqual({
      mode: "postal",
      country: DEFAULT_LOCATION_PREF.country,
      postal: "12345",
      lat: null,
      lng: null,
      radius: DEFAULT_LOCATION_PREF.radius,
    });
  });

  it("accepts the 'anywhere' radius", () => {
    const raw = JSON.stringify({ mode: "postal", country: "US", postal: "02144", radius: "anywhere" });
    expect(deserializeLocationPref(raw)?.radius).toBe("anywhere");
  });
});

describe("load/saveLocationPref", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("persists to and reads back from localStorage under the versioned key", async () => {
    const pref: LocationPref = { mode: "postal", country: "US", postal: "02144", lat: null, lng: null, radius: 25 };
    await saveLocationPref(pref);

    expect(window.localStorage.getItem(LOCATION_PREF_STORAGE_KEY)).not.toBeNull();
    await expect(loadLocationPref()).resolves.toEqual(pref);
  });

  it("returns the default when nothing is stored", async () => {
    await expect(loadLocationPref()).resolves.toEqual(DEFAULT_LOCATION_PREF);
  });
});

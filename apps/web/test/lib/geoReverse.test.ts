// Ported from Finderly's `frontend/src/utils/__tests__/reverseGeocode.test.ts`,
// adapted for `reverseGeocode`'s postcode+country result shape (Keepsake
// supports more than one country; Finderly's original was US ZIP only).
import { MANUAL_ENTRY_MESSAGE, reverseGeocode } from "@/lib/geoReverse";

const okJson = (body: unknown) => ({ ok: true, json: async () => body });
const httpError = (status: number) => ({ ok: false, status, json: async () => ({}) });

describe("reverseGeocode", () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns the postcode from BigDataCloud when it succeeds (no fallback call)", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ postcode: "94103", countryCode: "US" }));

    await expect(reverseGeocode(37.77, -122.41)).resolves.toEqual({ postcode: "94103", countryCode: "US" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("api.bigdatacloud.net");
  });

  it("falls back to Nominatim when BigDataCloud rejects (network failure)", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Load failed")).mockResolvedValueOnce(okJson({ address: { postcode: "10001", country_code: "us" } }));

    await expect(reverseGeocode(40.71, -74.0)).resolves.toEqual({ postcode: "10001", countryCode: "US" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toContain("nominatim.openstreetmap.org");
  });

  it("falls back to Nominatim when BigDataCloud returns no postcode", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ city: "Nowhere" })).mockResolvedValueOnce(okJson({ address: { postcode: "60601" } }));

    await expect(reverseGeocode(41.88, -87.62)).resolves.toEqual({ postcode: "60601", countryCode: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to Nominatim when BigDataCloud returns a non-OK HTTP status", async () => {
    fetchMock.mockResolvedValueOnce(httpError(429)).mockResolvedValueOnce(okJson({ address: { postcode: "30301" } }));

    await expect(reverseGeocode(33.74, -84.39)).resolves.toEqual({ postcode: "30301", countryCode: null });
  });

  it("throws a single manual-entry error when BOTH providers fail", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Load failed")).mockRejectedValueOnce(new TypeError("Load failed"));

    await expect(reverseGeocode(0, 0)).rejects.toThrow(MANUAL_ENTRY_MESSAGE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws the manual-entry error when neither provider yields a postcode", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ city: "Nowhere" })).mockResolvedValueOnce(okJson({ address: {} }));

    await expect(reverseGeocode(0, 0)).rejects.toThrow(/type it in/);
  });

  it("tolerates the other postcode key spellings", async () => {
    fetchMock.mockResolvedValueOnce(okJson({ zip: "02144" }));
    await expect(reverseGeocode(42.39, -71.1)).resolves.toEqual({ postcode: "02144", countryCode: null });
  });
});

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedStandardPostalCodes } from "./helpers.js";
import type { PostalLookup } from "@keepsake/contracts/geo";

describe("GET /api/geo/lookup", () => {
  it("resolves 02144 to Somerville, MA (plan M1 DoD)", async () => {
    await seedStandardPostalCodes();
    const res = await SELF.fetch("http://x/api/geo/lookup?country=US&code=02144");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: PostalLookup };
    expect(body.data.place_name).toBe("Somerville");
    expect(body.data.admin1).toBe("MA");
  });

  it("resolves M5V to Toronto (FSA level)", async () => {
    await seedStandardPostalCodes();
    const res = await SELF.fetch("http://x/api/geo/lookup?country=CA&code=M5V");
    const body = (await res.json()) as { ok: true; data: PostalLookup };
    expect(body.data.place_name).toBe("Toronto");
  });

  it("resolves a full CA postal code down to its FSA (M5V 3L9 -> M5V)", async () => {
    await seedStandardPostalCodes();
    const res = await SELF.fetch("http://x/api/geo/lookup?country=CA&code=M5V%203L9");
    const body = (await res.json()) as { ok: true; data: PostalLookup };
    expect(body.data.code).toBe("M5V");
  });

  it("resolves SW1A to London (GB outward code)", async () => {
    await seedStandardPostalCodes();
    const res = await SELF.fetch("http://x/api/geo/lookup?country=GB&code=SW1A%201AA");
    const body = (await res.json()) as { ok: true; data: PostalLookup };
    expect(body.data.place_name).toBe("London");
  });

  it("404s not_found for a postcode the seed doesn't cover", async () => {
    const res = await SELF.fetch("http://x/api/geo/lookup?country=US&code=99999");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: false; error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("400s bad_request for a missing country", async () => {
    const res = await SELF.fetch("http://x/api/geo/lookup?code=02144");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: false; error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });
});

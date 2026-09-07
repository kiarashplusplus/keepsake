/**
 * Issue #10 — proves `src/middleware/securityHeaders.ts` is actually wired
 * into `app.use("*", ...)` in `src/index.ts`, on both kinds of response it
 * exists to cover: a JSON `/api/*` response and the SPA-shell HTML served
 * through the `ASSETS` fallback route. This can't exercise
 * `apps/web/public/_headers` at all — that file is applied by the
 * Cloudflare assets binding at deploy time, not by anything running inside
 * this Worker under vitest — so it is not asserted on here; see that file's
 * own comment for what it sets and why.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const EXPECTED_STATIC_HEADERS: Record<string, string> = {
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
};

function expectSecurityHeaders(res: Response): void {
  for (const [name, value] of Object.entries(EXPECTED_STATIC_HEADERS)) {
    expect(res.headers.get(name)).toBe(value);
  }
  const csp = res.headers.get("content-security-policy");
  expect(csp).not.toBeNull();
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  // The two hashes every exported page carries: the combined pre-hydration
  // script (apps/web/app/+html.tsx's PREHYDRATION_SCRIPT — the no-flash
  // theme read, plus, since issue #44, the new-visitor root redirect) and
  // Expo Router's own hydration-flag script.
  expect(csp).toContain("'sha256-VYy8ShHUfzzRt7GXnoWUg8bhL+AVi/uK7Oqzytw8Se4='");
  expect(csp).toContain("'sha256-67fhrP0+BkBqmgGGXTtgiVO/9EQs3QruYNU/7fnRkI8='");
  expect(csp).toContain("https://challenges.cloudflare.com");
  // Issue #132: `connect-src` was absent entirely, so it fell back to
  // `default-src 'self'` and the browser dropped the give flow's
  // reverse-geocode calls. Asserted on the header this Worker really emits,
  // not just on the source string — `apps/web/test/guards/reverseGeocodeCsp.test.ts`
  // is the half that keeps this list in step with the code that needs it.
  expect(csp).toContain("connect-src 'self' https://api.bigdatacloud.net https://nominatim.openstreetmap.org");
}

describe("security headers", () => {
  it("are present on a JSON /api/* response", async () => {
    const res = await SELF.fetch("http://x/api/nope");
    expect(res.status).toBe(404);
    expectSecurityHeaders(res);
  });

  it("are present on the SPA-shell HTML response served through ASSETS", async () => {
    const res = await SELF.fetch("http://x/some/spa/route");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expectSecurityHeaders(res);
  });
});

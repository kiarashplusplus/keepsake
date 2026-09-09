/**
 * Issue #272 — `not_found_handling = "single-page-application"` answers a
 * miss anywhere under the static tree with `200 text/html` (the SPA shell),
 * which is right for an app route (a hard refresh on `/item/:id` has to come
 * back as the shell) but wrong for a route-split chunk under
 * `_expo/static/*`: a deploy rotates those content-hashed filenames, so a
 * tab left open across one can request a chunk that no longer exists and
 * silently get HTML back instead of a diagnosable 404. `src/index.ts`'s
 * catch-all now answers that specific miss with a real, uncached 404 instead
 * of falling through to the shell — this proves both halves: the chunk path
 * gets a truthful 404, and an ordinary app route (which has no on-disk file
 * at all in the fixture tree either) still gets the shell, unaffected.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("chunk-path miss vs. app-route miss (#272)", () => {
  it("answers a missing hashed chunk under _expo/static/* with a real, uncached 404", async () => {
    const res = await SELF.fetch("http://x/_expo/static/js/web/give-doesnotexist12345678.js");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).not.toContain("text/html");
  });

  it("still serves a chunk that actually exists at that path, unaffected", async () => {
    // Fixture at test/fixtures/public/_expo/static/js/web/existing-deadbeef.js
    const res = await SELF.fetch("http://x/_expo/static/js/web/existing-deadbeef.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).not.toContain("text/html");
    const text = await res.text();
    expect(text).toContain("existing chunk");
  });

  it("answers a nonexistent app route with the 404 page, and says so in the status", async () => {
    // Same "no file on disk at this path" shape as the chunk case above, but
    // outside the _expo/static prefix. This assertion is the inverse of what
    // it was until 2026-09-09: it used to require the SPA shell at 200,
    // because `not_found_handling = "single-page-application"` had no other
    // answer and a hard refresh of a dynamic route depended on it. The
    // discoverability pass measured what that cost on the live site — every
    // unexported path on `keepsake.ing`, `/sitemap` and `/Welcome` included,
    // answered 200 with `/`'s exact bytes — and `404-page` handling plus
    // `src/index.ts`'s `DYNAMIC_ROUTE_SHELLS` replaced it. The dynamic
    // routes that used to rely on the fallback are covered by
    // `notFound.test.ts`; this is the case that must NOT get a shell.
    const res = await SELF.fetch("http://x/give/some/deep/route/nothing/serves");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).toContain("not found stub");
  });
});

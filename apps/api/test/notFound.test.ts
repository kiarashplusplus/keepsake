/**
 * A URL nobody exported must answer 404, and a URL Expo Router exported under
 * a `[param]` filename must still answer with that route's own page.
 *
 * Measured on production, 2026-09-09 (`docs/runbooks/seo-audit.md`):
 * `GET https://keepsake.ing/nonexistent-page-xyz` returned `200 text/html`
 * with the *same* `ETag` as `/` — `48d6c1f…` on both — and so did
 * `/sitemap`, `/Welcome` and every other path nobody had exported. That is
 * `not_found_handling = "single-page-application"` doing exactly what it
 * says: answer every miss with `index.html`. For a crawler it means the site
 * has an unbounded supply of URLs that all resolve, all duplicate the
 * homepage, and all spend crawl budget that should be reaching listings —
 * and no `<link rel="canonical">` anywhere to consolidate them, because the
 * shell could not carry one.
 *
 * `404-page` handling fixes the status. The risk it creates, and the reason
 * both halves are asserted here rather than only the first: five routes
 * (`/mine/:id`, `/recover/:token`, `/withdraw/:token`, `/confirm/:token`,
 * `/bulk/:batchKey/...`) have no file at their own path and were relying on
 * that same fallback to come back at all. `src/index.ts`'s
 * `DYNAMIC_ROUTE_SHELLS` serves each its own exported shell instead — which
 * is also a fix in its own right, since the fallback was handing them
 * `index.html`, the *feed's* markup, to paint before hydration.
 *
 * `apps/web/e2e/deepLinkColdLoad.spec.ts` is the other half of this: it
 * cold-loads every one of those routes in a real browser and asserts the
 * screen renders. This file asserts the bytes and the status code, which the
 * browser test cannot see (`page.goto` does not fail on a 404).
 *
 * The fixture tree (`test/fixtures/public`, wired up in `vitest.config.ts`)
 * carries `404.html`, `mine/[id].html` and `bulk/[batchKey]/review.html` for
 * exactly this, each with a distinct body string so a wrong substitution
 * cannot pass as a right one.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("a path nobody exported", () => {
  it("answers 404 with the 404 page, not the homepage at 200", async () => {
    const res = await SELF.fetch("http://x/nonexistent-page-xyz");
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toContain("not found stub");
    // The specific regression: it must not be `index.html`'s body.
    expect(text).not.toContain("<body>stub</body>");
  });

  it("answers 404 for a deep path under a real route prefix", async () => {
    // `/give` exists; `/give/nope/nope` does not. A prefix match must not be
    // enough to earn a 200.
    const res = await SELF.fetch("http://x/give/nope/nope");
    expect(res.status).toBe(404);
  });

  it("is not cached, so a route added later is not shadowed by a stored 404", async () => {
    const res = await SELF.fetch("http://x/nonexistent-page-xyz");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("a dynamic app route's hard refresh", () => {
  it("serves /mine/:id its own shell rather than the feed's", async () => {
    const res = await SELF.fetch("http://x/mine/abc123");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    expect(text).toContain("mine detail stub");
    // The bug this replaces: `index.html` — the feed — was what came back.
    expect(text).not.toContain("<body>stub</body>");
  });

  it("serves a nested dynamic route (/bulk/:batchKey/review) its own shell", async () => {
    const res = await SELF.fetch("http://x/bulk/batch-key-1/review");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("bulk review stub");
  });

  it("does not extend the shell to an unknown step under the same prefix", async () => {
    // `/bulk/:batchKey/{photos,review,submit}` are enumerated, not globbed,
    // precisely so this stays a 404 instead of every typo under a batch key
    // resolving to a page.
    const res = await SELF.fetch("http://x/bulk/batch-key-1/nonsense");
    expect(res.status).toBe(404);
  });

  it("does not extend the shell one segment deeper than the route goes", async () => {
    const res = await SELF.fetch("http://x/mine/abc123/extra");
    expect(res.status).toBe(404);
  });
});

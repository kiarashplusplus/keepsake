/**
 * Launch audit finding 2: `preview.keepsake.ing` served `Allow: /` and a
 * complete `/sitemap.xml` of every preview listing, because `robots.txt` was
 * one static asset shared by both deploys and the sitemap built its URLs from
 * `SITE_URL`. Google could list a second Keepsake whose notification email is
 * silently dropped, and a stranger could post a real keepsake into it.
 *
 * These tests are the proof the guard fires, and every one of them is written
 * so it *can* fail: each environment-dependent assertion has its opposite
 * environment asserted alongside it in the same file, against the same code
 * path. A single-environment assertion here would be worthless — the bug was
 * precisely that both environments got the same answer.
 */
import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { setTestEnvVar } from "./helpers.js";

/** `vitest.config.ts` pins `ENVIRONMENT: "test"`; every test below restores
 * it, since `env` is shared with any other test file in the same isolate. */
const DEFAULT_ENVIRONMENT = "test";

describe("GET /robots.txt", () => {
  afterEach(() => {
    setTestEnvVar("ENVIRONMENT", DEFAULT_ENVIRONMENT);
  });

  it("disallows everything on a non-production deploy", async () => {
    setTestEnvVar("ENVIRONMENT", "preview");

    const res = await SELF.fetch("http://x/robots.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");

    const body = await res.text();
    expect(body).toContain("User-agent: *");
    expect(body).toContain("Disallow: /");
    expect(body).not.toContain("Allow: /");
    // The blanket disallow must not be paired with a sitemap pointing a
    // crawler straight back at the pages it just asked them not to fetch.
    expect(body).not.toContain("Sitemap:");
  });

  // The other half of the same behaviour, so neither assertion can pass
  // vacuously: production still serves the real, crawlable file — and serves
  // it *from the ASSETS binding*, which is what keeps
  // `apps/web/public/robots.txt` the one place the production rules are
  // edited. (`test/fixtures/public/robots.txt` is this suite's stand-in for
  // that asset and mirrors it; it is the ASSETS directory `vitest.config.ts`
  // points at.)
  it("serves the static asset, sitemap line and all, on production", async () => {
    setTestEnvVar("ENVIRONMENT", "production");

    const res = await SELF.fetch("http://x/robots.txt");
    expect(res.status).toBe(200);

    const body = await res.text();
    expect(body).toContain("Allow: /");
    expect(body).toContain("Sitemap: https://keepsake.ing/sitemap.xml");
    expect(body).not.toMatch(/^Disallow: \/$/m);
  });
});

describe("X-Robots-Tag", () => {
  afterEach(() => {
    setTestEnvVar("ENVIRONMENT", DEFAULT_ENVIRONMENT);
  });

  // robots.txt is a request a crawler may skip; this header rides on a
  // response it already has, and is what removes an already-indexed preview
  // URL rather than merely asking not to add one.
  it("marks every non-production response noindex", async () => {
    setTestEnvVar("ENVIRONMENT", "preview");

    const feed = await SELF.fetch("http://x/api/feed");
    expect(feed.headers.get("x-robots-tag")).toBe("noindex, nofollow");

    const spa = await SELF.fetch("http://x/some/spa/route");
    expect(spa.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("sets no such header on production", async () => {
    setTestEnvVar("ENVIRONMENT", "production");

    const feed = await SELF.fetch("http://x/api/feed");
    expect(feed.headers.get("x-robots-tag")).toBeNull();

    const spa = await SELF.fetch("http://x/some/spa/route");
    expect(spa.headers.get("x-robots-tag")).toBeNull();
  });
});

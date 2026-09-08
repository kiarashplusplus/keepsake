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
    // Keep implementation notes in source and docs rather than exposing them
    // to everyone who opens this public, user-visible file.
    expect(body).toBe("User-agent: *\nAllow: /\n\nSitemap: https://keepsake.ing/sitemap.xml\n");
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

  // Issue #84: `/admin` is noindex'd unconditionally, in every environment —
  // not just non-production — because `apps/web/public/robots.txt` no longer
  // advertises the path with a `Disallow` line, so this header is the only
  // thing keeping it out of search results. Both assertions matter: a
  // version of this check that only exercised production could pass just as
  // happily if the override applied everywhere by accident and preview's
  // dedicated `/some/spa/route` case above happened to share the path.
  it("marks /admin noindex on production, same as everywhere else", async () => {
    setTestEnvVar("ENVIRONMENT", "production");

    const admin = await SELF.fetch("http://x/admin");
    expect(admin.headers.get("x-robots-tag")).toBe("noindex, nofollow");

    // The control: a production path that isn't /admin still gets nothing,
    // so this isn't just isProduction() silently inverted.
    const other = await SELF.fetch("http://x/some/other/route");
    expect(other.headers.get("x-robots-tag")).toBeNull();
  });

  // Issue #278: `/admin` used to be the only unconditionally-noindexed path,
  // an exact string compare that missed every other route reachable only
  // with a credential — `/bulk` went live in production (`BULK_UPLOAD =
  // "1"`) with nothing keeping its workspace out of search. Each private-ish
  // route's *bare* path and one representative sub-path are checked, so a
  // prefix match that only worked for one shape would still fail here.
  it.each([
    ["/admin"],
    ["/bulk"],
    ["/bulk/new"],
    ["/bulk/abc123/review"],
    ["/mine"],
    ["/mine/some-id"],
    ["/mine/email"],
    ["/recover"],
    ["/recover/some-token"],
    ["/withdraw/some-token"],
    ["/confirm/some-token"],
  ])("marks %s noindex on production", async (path) => {
    setTestEnvVar("ENVIRONMENT", "production");

    const res = await SELF.fetch(`http://x${path}`);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  // The control side of the same change: the content this product wants
  // found stays indexable on production, so the prefix list isn't so broad
  // it swallows the feed or a listing along with the private routes.
  it.each([["/"], ["/item/some-listing-id"], ["/welcome"], ["/about"]])(
    "leaves %s indexable on production",
    async (path) => {
      setTestEnvVar("ENVIRONMENT", "production");

      const res = await SELF.fetch(`http://x${path}`);
      expect(res.headers.get("x-robots-tag")).toBeNull();
    },
  );
});

import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertApprovedListing, insertOwner, setTestEnvVar } from "./helpers.js";

/** `vitest.config.ts` pins `ENVIRONMENT: "test"`. Since launch audit finding
 * 2, a sitemap is only served on production — every deploy that is not
 * production 404s here (see the last test in this file) — so the tests that
 * assert the sitemap's *contents* have to say which environment they are
 * asking as. Restored after each test: `env` is shared with any other test
 * file in the same isolate. */
const DEFAULT_ENVIRONMENT = "test";

describe("GET /sitemap.xml", () => {
  beforeEach(() => {
    setTestEnvVar("ENVIRONMENT", "production");
  });

  afterEach(() => {
    setTestEnvVar("ENVIRONMENT", DEFAULT_ENVIRONMENT);
  });

  it("lists the static pages and every approved listing", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId, title: "A quiet teacup" });

    const res = await SELF.fetch("http://x/sitemap.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/xml");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=600");

    const body = await res.text();
    expect(body).toContain("<loc>http://localhost:8787/</loc>");
    expect(body).toContain("<loc>http://localhost:8787/about</loc>");
    expect(body).toContain("<loc>http://localhost:8787/privacy</loc>");
    expect(body).toContain("<loc>http://localhost:8787/terms</loc>");
    expect(body).toContain(`<loc>http://localhost:8787/item/${listingId}</loc>`);
  });

  it("omits a given listing", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId, title: "Already given" });
    await env.DB.prepare("UPDATE listings SET status = 'given' WHERE id = ?").bind(listingId).run();

    const res = await SELF.fetch("http://x/sitemap.xml");
    const body = await res.text();
    expect(body).not.toContain(`/item/${listingId}<`);
  });

  // Launch audit finding 2. Preview built every `<loc>` from its own
  // `SITE_URL`, so it published a crawlable index of a brand-named clone of
  // the product — listings whose givers would never be emailed, because
  // preview's `EMAIL_MODE=allowlist` drops every address but one. The two
  // tests above prove the production side still works, so this one cannot
  // pass by the handler being broken everywhere.
  it("404s off production, and does not leak a listing URL in the body", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId, title: "Preview-only teacup" });
    setTestEnvVar("ENVIRONMENT", "preview");

    const res = await SELF.fetch("http://x/sitemap.xml");
    expect(res.status).toBe(404);

    const body = await res.text();
    expect(body).not.toContain("<urlset");
    expect(body).not.toContain(listingId);
  });
});

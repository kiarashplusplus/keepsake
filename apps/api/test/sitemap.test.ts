import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { insertApprovedListing, insertOwner } from "./helpers.js";

describe("GET /sitemap.xml", () => {
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
});

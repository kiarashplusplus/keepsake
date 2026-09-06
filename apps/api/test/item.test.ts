import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { insertApprovedListing, insertOwner } from "./helpers.js";

describe("GET /item/:id", () => {
  it("injects OG/Twitter tags into the shell's <head> for an approved listing", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({
      ownerId,
      title: "A quiet teacup",
      story: "This was my grandmother's favorite teacup, and I'd love for it to find a new home.",
    });

    const res = await SELF.fetch(`http://x/item/${listingId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const html = await res.text();
    expect(html).toContain('<meta property="og:type" content="article">');
    expect(html).toContain('<meta property="og:title" content="A quiet teacup">');
    expect(html).toContain("<title>A quiet teacup — Keepsake</title>");
    expect(html).toContain(`<meta property="og:url" content="http://localhost:8787/item/${listingId}">`);
    expect(html).toContain('<link rel="canonical" href="http://localhost:8787/item/');
    expect(html).toContain("<!--KEEPSAKE_OG-->"); // marker is left alone, not removed
  });

  it("404s the unchanged shell for an unknown id", async () => {
    const res = await SELF.fetch("http://x/item/01UNKNOWNIDXXXXXXXXXXXXXXX");
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const html = await res.text();
    expect(html).not.toContain("og:title");
    expect(html).toContain("keepsake test fixture");
  });

  it("404s the unchanged shell for a pending listing", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId, title: "Not public yet" });
    // Flipped to `pending` after insert (the helper only inserts
    // `approved`) — same rule this route follows for a non-public status as
    // for an unknown id: never confirm it exists to someone who can't see it.
    await env.DB.prepare("UPDATE listings SET status = 'pending' WHERE id = ?").bind(listingId).run();

    const res = await SELF.fetch(`http://x/item/${listingId}`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).not.toContain("og:title");
  });
});

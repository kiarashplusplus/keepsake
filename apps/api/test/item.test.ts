import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { insertApprovedListing, insertOwner, realJpegBytes } from "./helpers.js";
import { ulid } from "../src/lib/ids.js";

/** A photo row + R2 objects, so `og:image` has something to point at. */
async function insertPhoto(ownerId: string, listingId: string): Promise<string> {
  const photoId = ulid();
  const bytes = realJpegBytes(32, 24);
  await env.BUCKET.put(`photos/${photoId}/full.jpg`, bytes);
  await env.BUCKET.put(`photos/${photoId}/thumb.jpg`, bytes);
  await env.DB.prepare(
    `INSERT INTO photos (id, owner_id, listing_id, position, r2_key_full, r2_key_thumb, width, height,
                         bytes_full, blurhash, content_type, moderation_status, created_at)
     VALUES (?, ?, ?, 0, ?, ?, 1200, 900, ?, 'LEHV6nWB2yk8', 'image/jpeg', 'passed', ?)`,
  )
    .bind(photoId, ownerId, listingId, `photos/${photoId}/full.jpg`, `photos/${photoId}/thumb.jpg`, bytes.length, Date.now())
    .run();
  return photoId;
}

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

    // Regression: the rewriter strips `meta[property^="og:"]`, which includes
    // the shell's own `og:site_name`, and for a long time never added it back
    // — every item page unfurled with no site name.
    expect(html).toContain('<meta property="og:site_name" content="Keepsake">');
    expect(html).toContain('<meta property="og:locale" content="en_US">');
  });

  it("points og:image at the share card, not the raw photo", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId, title: "A quiet teacup" });
    await insertPhoto(ownerId, listingId);

    const html = await (await SELF.fetch(`http://x/item/${listingId}`)).text();

    // The dimensions are advertised to unfurlers and must match what
    // `routes/ogCard.ts` actually renders — `test/ogCard.test.ts` decodes the
    // JPEG's SOF marker to check the other side of this contract.
    const card = new RegExp(
      `<meta property="og:image" content="http://localhost:8787/og/item/${listingId}/card\\.png\\?v=[0-9a-f]{12}">`,
    );
    expect(html).toMatch(card);
    expect(html).toContain('<meta property="og:image:type" content="image/jpeg">');
    expect(html).toContain('<meta property="og:image:width" content="1200">');
    expect(html).toContain('<meta property="og:image:height" content="630">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');

    // The old behaviour, explicitly gone: a raw `/i/<photo>/full` as the
    // preview image is what this whole feature replaced.
    expect(html).not.toContain('<meta property="og:image" content="http://localhost:8787/i/');

    // Alt text is a sentence, not the title echoed back at a screen reader.
    expect(html).toContain('<meta property="og:image:alt" content="A quiet teacup — a keepsake in Somerville, MA, free to a good home">');
  });

  it("emits no og:image at all when the listing has no photo", async () => {
    // Deliberately not a card URL that would 404: an unfurler that fetches a
    // 404 renders a torn-image placeholder, while one with no `og:image`
    // falls back to a clean text preview.
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId, title: "No photo here" });

    const html = await (await SELF.fetch(`http://x/item/${listingId}`)).text();
    expect(html).toContain('<meta property="og:title" content="No photo here">');
    expect(html).not.toContain('property="og:image"');
  });

  it("never leaks the listing's postcode into the head", async () => {
    // `postal_code` is owner-only data (`OwnerListing` carries it,
    // `PublicListing` does not) and this is the most widely redistributed
    // artifact the product emits. The card shows `place_name, admin1` only.
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId, postalCode: "02144" });
    await insertPhoto(ownerId, listingId);

    const html = await (await SELF.fetch(`http://x/item/${listingId}`)).text();
    expect(html).not.toContain("02144");
  });

  it("cuts the description at a word boundary, not mid-word", async () => {
    // Was `story.slice(0, 200)`, which cut wherever 200 characters landed.
    // Now the same `storyExcerpt` rule the feed card uses, so a keepsake
    // reads the same in the feed and in a link preview.
    const ownerId = await insertOwner();
    const story =
      "She used it every single day for her first cup of tea. " +
      "Then it sat wrapped in newspaper in a box that moved house four times without ever once being opened by anybody.";
    const listingId = await insertApprovedListing({ ownerId, story });

    const html = await (await SELF.fetch(`http://x/item/${listingId}`)).text();
    expect(html).toContain(
      '<meta property="og:description" content="She used it every single day for her first cup of tea.">',
    );
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

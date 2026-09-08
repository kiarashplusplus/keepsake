import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { insertApprovedListing, insertOwner, realJpegBytes } from "./helpers.js";
import { ulid } from "../src/lib/ids.js";

/** A photo row + R2 objects, so `og:image` has something to point at. */
async function insertPhoto(ownerId: string, listingId: string, contentType = "image/jpeg"): Promise<string> {
  const photoId = ulid();
  const bytes = realJpegBytes(32, 24);
  await env.BUCKET.put(`photos/${photoId}/full.jpg`, bytes);
  await env.BUCKET.put(`photos/${photoId}/thumb.jpg`, bytes);
  await env.DB.prepare(
    `INSERT INTO photos (id, owner_id, listing_id, position, r2_key_full, r2_key_thumb, width, height,
                         bytes_full, blurhash, content_type, moderation_status, created_at)
     VALUES (?, ?, ?, 0, ?, ?, 1200, 900, ?, 'LEHV6nWB2yk8', ?, 'passed', ?)`,
  )
    .bind(photoId, ownerId, listingId, `photos/${photoId}/full.jpg`, `photos/${photoId}/thumb.jpg`, bytes.length, contentType, Date.now())
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

  it("describes the raw photo, not a card, when the cover cannot be rasterised", async () => {
    // resvg decodes JPEG, PNG and GIF; `lib/imageSniff.ts` also accepts WebP
    // on upload, so `routes/ogCard.ts` degrades to streaming the raw photo at
    // the card's URL. Declaring 1200x630 JPEG for that would have every
    // unfurler lay out a box the image does not fill — the mismatch is
    // knowable here, so the tags tell the truth.
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId, title: "A WebP teacup" });
    await insertPhoto(ownerId, listingId, "image/webp");

    const html = await (await SELF.fetch(`http://x/item/${listingId}`)).text();
    expect(html).toContain('<meta property="og:image:type" content="image/webp">');
    expect(html).toContain('<meta property="og:image:width" content="1200">');
    expect(html).toContain('<meta property="og:image:height" content="900">');
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

  it("replaces the shell's site-wide meta description with the listing's own", async () => {
    // The plain `<meta name="description">` — the one a search result shows —
    // was the last tag this rewriter left alone, so every listing page in the
    // sitemap carried the shell's "Give a keepsake a second life.", identical
    // on all of them. Both halves are asserted: the shell's copy is gone (the
    // first description in <head> is the one that counts) and the listing's
    // own is there.
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({
      ownerId,
      title: "A quiet teacup",
      story: "She used it every single day for her first cup of tea.",
    });

    const html = await (await SELF.fetch(`http://x/item/${listingId}`)).text();

    expect(html).toContain(
      '<meta name="description" content="She used it every single day for her first cup of tea.">',
    );
    expect(html).not.toContain('content="Give a keepsake a second life."');
    // Exactly one, not the shell's plus ours.
    expect(html.match(/<meta name="description"/g)).toHaveLength(1);
  });

  it("404s the unchanged shell for an unknown id", async () => {
    const res = await SELF.fetch("http://x/item/01UNKNOWNIDXXXXXXXXXXXXXXX");
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const html = await res.text();
    // The shell comes back as it is served everywhere else — its own title
    // and its site-wide OG defaults intact — with nothing listing-specific
    // added. (It used to assert `not.toContain("og:title")`, which only held
    // because the fixture had no OG tags at all; the fixture now carries the
    // ones the real export ships, so this has to name what "unchanged"
    // means.)
    expect(html).toContain("keepsake test fixture");
    expect(html).toContain('<meta property="og:title" content="Keepsake" />');
    expect(html).not.toContain("og:url");
    expect(html).not.toContain('rel="canonical"');
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
    // The strongest form of "never confirm it exists": the row's own title
    // appears nowhere in the response, and no per-listing tag was injected.
    expect(html).not.toContain("Not public yet");
    expect(html).not.toContain("og:url");
    expect(html).not.toContain('rel="canonical"');
    expect(html).toContain("keepsake test fixture");
  });
});

describe("GET /item/:id — structured data", () => {
  /** The single `application/ld+json` block, parsed. */
  async function readJsonLd(listingId: string): Promise<Record<string, unknown>> {
    const html = await (await SELF.fetch(`http://x/item/${listingId}`)).text();
    const match = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    expect(match).not.toBeNull();
    return JSON.parse((match as RegExpExecArray)[1] as string) as Record<string, unknown>;
  }

  it("describes the keepsake as a free, used Product", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId, title: "A quiet teacup" });
    await insertPhoto(ownerId, listingId);

    const ld = await readJsonLd(listingId);
    expect(ld["@type"]).toBe("Product");
    expect(ld.name).toBe("A quiet teacup");
    expect(ld.itemCondition).toBe("https://schema.org/UsedCondition");
    expect(ld.image).toEqual([expect.stringMatching(/\/i\/[0-9A-Z]+\/full$/)]);

    const offer = ld.offers as Record<string, unknown>;
    expect(offer["@type"]).toBe("Offer");
    // "0" as a string, not the number 0 — schema.org's price is a Text/Number
    // union and a falsy number is exactly the sort of thing a consumer drops.
    expect(offer.price).toBe("0");
    expect(offer.priceCurrency).toBe("USD");
    expect(offer.availability).toBe("https://schema.org/InStock");
  });

  it("flips availability to SoldOut once the keepsake is given", async () => {
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });
    await env.DB.prepare("UPDATE listings SET status = 'given' WHERE id = ?").bind(listingId).run();

    const offer = (await readJsonLd(listingId)).offers as Record<string, unknown>;
    // SoldOut, not OutOfStock: it is gone, not awaiting restock.
    expect(offer.availability).toBe("https://schema.org/SoldOut");
  });

  it("claims nothing it cannot back up", async () => {
    // No accounts, no inventory, no reviews — so no `seller`, `sku`, `brand`
    // or `aggregateRating`. Structured data is the one place a false claim is
    // machine-readable and repeated, and `aggregateRating` in particular is
    // what gets a site's rich results turned off entirely.
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });
    const ld = await readJsonLd(listingId);
    for (const key of ["seller", "sku", "brand", "aggregateRating", "review"]) {
      expect(ld).not.toHaveProperty(key);
    }
  });

  it("gives a location without the postcode, and omits admin1 rather than nulling it", async () => {
    const ownerId = await insertOwner();
    const withRegion = await insertApprovedListing({ ownerId, postalCode: "02144", placeName: "Somerville", admin1: "MA" });
    const ldWith = await readJsonLd(withRegion);
    const place = (ldWith.offers as Record<string, unknown>).availableAtOrFrom as Record<string, unknown>;
    const address = place.address as Record<string, unknown>;
    expect(address.addressLocality).toBe("Somerville");
    expect(address.addressRegion).toBe("MA");
    expect(address.addressCountry).toBe("US");
    expect(address).not.toHaveProperty("postalCode");

    // Set via SQL, not through the helper: `insertApprovedListing` defaults
    // `admin1` with `??`, so passing `null` yields "MA" and the test would
    // assert nothing.
    const noRegion = await insertApprovedListing({ ownerId, placeName: "Somewhere" });
    await env.DB.prepare("UPDATE listings SET admin1 = NULL WHERE id = ?").bind(noRegion).run();
    const ldWithout = await readJsonLd(noRegion);
    const addressWithout = ((ldWithout.offers as Record<string, unknown>).availableAtOrFrom as Record<string, unknown>)
      .address as Record<string, unknown>;
    // Absent, not `null`: validators treat an explicit null as a malformed
    // value rather than a missing one.
    expect(addressWithout).not.toHaveProperty("addressRegion");
  });

  it("survives a title that tries to break out of the script block", async () => {
    // The reason `lib/jsonLd.ts` exists and the reason it must never be
    // "tidied" into `escapeHtml`. Two things have to hold at once: the block
    // cannot be terminated early, AND the value must round-trip byte for
    // byte — HTML-entity escaping would satisfy the first and quietly fail
    // the second, turning "Salt & pepper" into "Salt &amp;amp; pepper" in
    // Google's index.
    const hostile = `A "teacup" </script><img src=x onerror=alert(1)> & <b>`;
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId, title: hostile });

    const html = await (await SELF.fetch(`http://x/item/${listingId}`)).text();
    const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html) as RegExpExecArray;

    expect(block[1]).not.toContain("</script>");
    expect(block[1]).not.toContain("<img");
    const parsed = JSON.parse(block[1] as string) as Record<string, unknown>;
    expect(parsed.name).toBe(hostile);

    // And the OG meta tag, which IS an HTML attribute, is escaped the other
    // way — two destinations, two rules, both exercised here.
    expect(html).toContain("&lt;/script&gt;");
  });

  it("injects exactly one Product block, however many others the shell carries", async () => {
    // Two `Product` blocks on one page is a validation error, and is what an
    // absent-minded second `el.append` would produce. That is the invariant.
    //
    // This test used to assert exactly one `ld+json` block on the page, which
    // is FALSE in production and passed only because `test/fixtures/public`'s
    // shell is a stub. The real exported shell carries its own
    // WebSite/Organization block (`apps/web/app/+html.tsx`), so a live item
    // page has two — verified against preview after deploy. A sitewide
    // identity block plus a per-page Product is the intended shape; counting
    // blocks was measuring the fixture, not the behaviour.
    const ownerId = await insertOwner();
    const listingId = await insertApprovedListing({ ownerId });
    const html = await (await SELF.fetch(`http://x/item/${listingId}`)).text();

    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(
      (match) => JSON.parse(match[1] as string) as unknown,
    );
    const products = blocks.flat().filter((node) => (node as { "@type"?: string })["@type"] === "Product");
    expect(products).toHaveLength(1);
  });

  it("puts no structured data on a page that is not a listing", async () => {
    // A 404 shell must stay the unchanged shell — describing a Product that
    // does not exist, or confirming an id does, are both wrong.
    const html = await (await SELF.fetch("http://x/item/01UNKNOWNIDXXXXXXXXXXXXXXX")).text();
    expect(html).not.toContain("application/ld+json");
  });
});

/**
 * `GET /item/:id` — the static SPA shell (`env.ASSETS`'s `index.html`) with
 * `<head>` tags injected via `HTMLRewriter` so a link unfurl (iMessage,
 * WhatsApp, Slack) shows the keepsake's photo and title without ever running
 * the client bundle's JS. Mounted at the Worker root, not under `/api` — the
 * plan's route table lists it as `GET /item/:id (HTML)` — and only reached
 * at all because `wrangler.toml`'s `run_worker_first` lists `/item/*`,
 * overriding the static-assets system that would otherwise serve this same
 * path directly.
 *
 * `og:image` points at the designed share card (`routes/ogCard.ts`), NOT at
 * the raw photo it used to serve. A 2048px camera original at whatever aspect
 * ratio the giver's phone produced is cropped differently by every unfurler
 * and carries no branding at all; the card is 1200x630 by construction.
 *
 * Note the selector below removes `meta[property^="og:"]`, which includes the
 * shell's `og:site_name` — for a long time this route deleted it and never
 * added it back, so every item page unfurled with no site name. It is in
 * `buildOgTags` now, and `test/item.test.ts` asserts it.
 *
 * The same shape one tag over: until 2026-09-08 this route rewrote the title
 * and every `og:`/`twitter:` tag but left `<meta name="description">` alone,
 * so every listing page carried the shell's site-wide "Give a keepsake a
 * second life." — the plain description a search engine reads, identical on
 * every item URL in the sitemap. It is rewritten from the same
 * `storyExcerpt` the OG description uses (one sentence, one source), and the
 * selector below drops the shell's copy first for the same reason it drops
 * the shell's title: the first one in `<head>` is the one that counts.
 *
 * `HTMLRewriter` can't target an HTML comment (`<!--KEEPSAKE_OG-->` in the
 * exported shell's `<head>`) directly, so per the plan this appends the new
 * tags at the end of `<head>` instead and leaves the marker alone — both are
 * fine, since order within `<head>` doesn't matter for OG/Twitter tags.
 *
 * Unknown/hidden/pending ids serve the exact same shell, unchanged, at 404 —
 * the SPA's own not-found route renders from there. This route never reveals
 * whether an id exists to someone who can't see it (same rule `src/routes/
 * images.ts` follows for photos).
 */
import { Hono } from "hono";
import { CATEGORY_LABELS, type Category } from "@keepsake/contracts/listing";
import { CURRENCY_BY_COUNTRY, type Country as GeoCountry } from "@keepsake/contracts/geo";
import { storyExcerpt } from "@keepsake/contracts/story";
import type { Env } from "../env.js";
import { fetchListingRow, fetchPhotoRows } from "../lib/listingsDb.js";
import { jsonLdScript, type JsonLdValue } from "../lib/jsonLd.js";
import { CARD_HEIGHT, CARD_WIDTH } from "../og/card.js";
import { RENDERABLE_COVER_TYPES } from "../og/render.js";
import { cardFingerprint, placeLine } from "../og/fingerprint.js";
import { requireParam } from "../lib/params.js";
import { burst } from "../middleware/rateLimit.js";

export const itemRoutes = new Hono<{ Bindings: Env }>();

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildOgTags(params: {
  title: string;
  description: string;
  url: string;
  /** The share card's absolute URL, or `undefined` when the listing has no photo. */
  cardUrl?: string;
  /** Alt text for the card — a real sentence, not the title repeated. */
  cardAlt: string;
  /** The image's real dimensions. 1200x630 for a card; the photo's own when
   * `cardUrl` points at a fallback that cannot be rasterised. */
  imageWidth: number;
  imageHeight: number;
  imageType: string;
}): string {
  const title = escapeHtml(params.title);
  const description = escapeHtml(params.description);
  const url = escapeHtml(params.url);

  // No `og:image` at all rather than a broken one when there is nothing to
  // show: an unfurler that fetches a 404 renders a torn-image placeholder,
  // while one with no `og:image` falls back to a clean text-only preview.
  const imageTags = params.cardUrl
    ? [
        `<meta property="og:image" content="${escapeHtml(params.cardUrl)}">`,
        `<meta property="og:image:secure_url" content="${escapeHtml(params.cardUrl)}">`,
        `<meta property="og:image:type" content="${escapeHtml(params.imageType)}">`,
        `<meta property="og:image:width" content="${params.imageWidth}">`,
        `<meta property="og:image:height" content="${params.imageHeight}">`,
        `<meta property="og:image:alt" content="${escapeHtml(params.cardAlt)}">`,
        `<meta name="twitter:card" content="summary_large_image">`,
        `<meta name="twitter:image" content="${escapeHtml(params.cardUrl)}">`,
      ].join("\n    ")
    : "";

  return `
    <title>${title} — Keepsake</title>
    <meta name="description" content="${description}">
    <link rel="canonical" href="${url}">
    <meta property="og:type" content="article">
    <meta property="og:site_name" content="Keepsake">
    <meta property="og:locale" content="en_US">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    <meta property="og:url" content="${url}">
    ${imageTags}
  `;
}

/**
 * schema.org `Product` for the listing.
 *
 * `Product` with a zero-price `Offer` rather than a bare `CreativeWork`: a
 * keepsake is a physical second-hand object someone can acquire, which is
 * what `Product` describes, and `price: "0"` is how "free" is stated in a way
 * a search engine understands. `priceCurrency` is required whenever `price`
 * is present (hence `CURRENCY_BY_COUNTRY`), even though nothing here is ever
 * sold.
 *
 * Deliberately absent: `seller`, `sku`, `brand`, `aggregateRating`,
 * `review`. There are no accounts, no inventory and no reviews on this
 * platform, and inventing any of them would be a false claim in structured
 * data — the one place a false claim is machine-readable and repeated.
 *
 * **`postal_code` never appears.** `listings.postal_code` is owner-only
 * (`OwnerListing` carries it, `PublicListing` does not), so `PostalAddress`
 * gets `addressLocality`/`addressRegion` only. `test/item.test.ts` asserts
 * the postcode is absent from the whole response, not just from this object.
 */
function buildProductJsonLd(params: {
  id: string;
  title: string;
  description: string;
  url: string;
  status: string;
  country: string;
  placeName: string;
  admin1: string | null;
  categoryLabel: string;
  imageUrls: string[];
}): string {
  const currency = CURRENCY_BY_COUNTRY[params.country as GeoCountry];

  const address: Record<string, JsonLdValue | undefined> = {
    "@type": "PostalAddress",
    addressLocality: params.placeName,
    // Omitted entirely when null — never emitted as `null`, which validators
    // treat as a malformed value rather than an absent one.
    ...(params.admin1 ? { addressRegion: params.admin1 } : {}),
    addressCountry: params.country,
  };

  const product: Record<string, JsonLdValue | undefined> = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: params.title,
    description: params.description,
    url: params.url,
    category: params.categoryLabel,
    itemCondition: "https://schema.org/UsedCondition",
    ...(params.imageUrls.length > 0 ? { image: params.imageUrls } : {}),
    offers: {
      "@type": "Offer",
      price: "0",
      // A listing whose country somehow isn't US/CA gets no price at all
      // rather than an `Offer` missing its required `priceCurrency`.
      ...(currency ? { priceCurrency: currency } : {}),
      // `SoldOut`, not `OutOfStock`: the keepsake is gone, not restockable.
      availability: params.status === "given" ? "https://schema.org/SoldOut" : "https://schema.org/InStock",
      itemCondition: "https://schema.org/UsedCondition",
      url: params.url,
      availableAtOrFrom: { "@type": "Place", address },
    },
  };

  return jsonLdScript(product as JsonLdValue);
}

itemRoutes.get("/:id", burst("RL_READ"), async (c) => {
  const id = requireParam(c, "id");
  const shellRequest = new Request(new URL("/", c.req.url), { headers: c.req.raw.headers });
  const shellResponse = await c.env.ASSETS.fetch(shellRequest);

  const row = await fetchListingRow(c.env, id);

  // Never cached — a rewritten shell for a listing that later goes
  // `given`/`hidden` must not be served stale to the next unfurl.
  const headers = new Headers(shellResponse.headers);
  headers.set("Cache-Control", "no-store");

  if (row === null || (row.status !== "approved" && row.status !== "given")) {
    return new Response(shellResponse.body, { status: 404, statusText: "Not Found", headers });
  }

  const photos = await fetchPhotoRows(c.env, id);
  const firstPhoto = photos[0];
  const siteUrl = c.env.SITE_URL;
  const pageUrl = `${siteUrl}/item/${id}`;
  const place = placeLine(row.place_name, row.admin1);

  // The `?v=` is what makes an edit visible in a preview that has already
  // been shared: WhatsApp and Facebook cache unfurl images by URL on their
  // own infrastructure and expose no flush. Computed by the SAME function the
  // card route keys R2 with (`og/fingerprint.ts`) so the HTML can never
  // advertise a version the route would not produce.
  // A cover resvg cannot decode (WebP — accepted on upload, never written by
  // the official client) means `routes/ogCard.ts` will fall back to streaming
  // the raw photo at the card's URL. Declaring 1200x630 JPEG for it would
  // make every unfurler lay out a box the image does not fill, so when that
  // is knowable here the tags describe the photo instead.
  const coverRenderable = firstPhoto !== undefined && RENDERABLE_COVER_TYPES.has(firstPhoto.content_type ?? "image/jpeg");

  const cardUrl = firstPhoto
    ? `${siteUrl}/og/item/${id}/card.png?v=${await cardFingerprint({
        id: row.id,
        version: row.version,
        status: row.status,
        title: row.title,
        story: row.story,
        place,
        categoryLabel: CATEGORY_LABELS[row.category as Category] ?? row.category,
        coverPhotoId: firstPhoto.id,
      })}`
    : undefined;

  const tags = buildOgTags({
    title: row.title,
    // `storyExcerpt`, not `story.slice(0, 200)`. The slice cut mid-word, and
    // this is the sentence a friend reads under the card — it should be the
    // same one the feed shows. See `@keepsake/contracts/story`.
    description: storyExcerpt(row.story, 200),
    url: pageUrl,
    cardAlt: `${row.title} — a keepsake in ${place}, free to a good home`,
    imageWidth: coverRenderable ? CARD_WIDTH : (firstPhoto?.width ?? CARD_WIDTH),
    imageHeight: coverRenderable ? CARD_HEIGHT : (firstPhoto?.height ?? CARD_HEIGHT),
    imageType: coverRenderable ? "image/jpeg" : (firstPhoto?.content_type ?? "image/jpeg"),
    ...(cardUrl ? { cardUrl } : {}),
  });

  // The canonical image for structured data is the photo itself, not the
  // share card: `/i/:id/full` is what the page actually shows, and the card
  // is a social artifact (it is served `X-Robots-Tag: noindex`).
  const jsonLd = buildProductJsonLd({
    id: row.id,
    title: row.title,
    description: storyExcerpt(row.story, 200),
    url: pageUrl,
    status: row.status,
    country: row.country,
    placeName: row.place_name,
    admin1: row.admin1,
    categoryLabel: CATEGORY_LABELS[row.category as Category] ?? row.category,
    imageUrls: photos.map((photo) => `${siteUrl}/i/${photo.id}/full`),
  });

  // Drop the shell's default title/OG/Twitter tags first: crawlers take the
  // first og:* they see, and the exported shell already carries the site-wide
  // defaults ahead of the marker.
  const rewriter = new HTMLRewriter()
    .on('title, link[rel="canonical"], meta[name="description"], meta[property^="og:"], meta[name^="twitter:"]', {
      element(el) {
        el.remove();
      },
    })
    .on("head", {
    element(el) {
      el.append(tags, { html: true });
      el.append(jsonLd, { html: true });
    },
  });

  const rewritten = rewriter.transform(new Response(shellResponse.body, shellResponse));
  const rewrittenHeaders = new Headers(rewritten.headers);
  rewrittenHeaders.set("Cache-Control", "no-store");
  return new Response(rewritten.body, { status: 200, headers: rewrittenHeaders });
});

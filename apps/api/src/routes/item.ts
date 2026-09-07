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
import { storyExcerpt } from "@keepsake/contracts/story";
import type { Env } from "../env.js";
import { fetchListingRow, fetchPhotoRows } from "../lib/listingsDb.js";
import { CARD_HEIGHT, CARD_WIDTH } from "../og/card.js";
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
        `<meta property="og:image:type" content="image/jpeg">`,
        `<meta property="og:image:width" content="${CARD_WIDTH}">`,
        `<meta property="og:image:height" content="${CARD_HEIGHT}">`,
        `<meta property="og:image:alt" content="${escapeHtml(params.cardAlt)}">`,
        `<meta name="twitter:card" content="summary_large_image">`,
        `<meta name="twitter:image" content="${escapeHtml(params.cardUrl)}">`,
      ].join("\n    ")
    : "";

  return `
    <title>${title} — Keepsake</title>
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
    ...(cardUrl ? { cardUrl } : {}),
  });

  // Drop the shell's default title/OG/Twitter tags first: crawlers take the
  // first og:* they see, and the exported shell already carries the site-wide
  // defaults ahead of the marker.
  const rewriter = new HTMLRewriter()
    .on('title, link[rel="canonical"], meta[property^="og:"], meta[name^="twitter:"]', {
      element(el) {
        el.remove();
      },
    })
    .on("head", {
    element(el) {
      el.append(tags, { html: true });
    },
  });

  const rewritten = rewriter.transform(new Response(shellResponse.body, shellResponse));
  const rewrittenHeaders = new Headers(rewritten.headers);
  rewrittenHeaders.set("Cache-Control", "no-store");
  return new Response(rewritten.body, { status: 200, headers: rewrittenHeaders });
});

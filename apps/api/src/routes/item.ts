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
import type { Env } from "../env.js";
import { fetchListingRow, fetchPhotoRows } from "../lib/listingsDb.js";
import { requireParam } from "../lib/params.js";

export const itemRoutes = new Hono<{ Bindings: Env }>();

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface OgImage {
  url: string;
  width: number;
  height: number;
}

function buildOgTags(params: { title: string; description: string; url: string; image?: OgImage }): string {
  const title = escapeHtml(params.title);
  const description = escapeHtml(params.description);
  const url = escapeHtml(params.url);
  const imageTags = params.image
    ? [
        `<meta property="og:image" content="${escapeHtml(params.image.url)}">`,
        `<meta property="og:image:width" content="${params.image.width}">`,
        `<meta property="og:image:height" content="${params.image.height}">`,
        `<meta name="twitter:card" content="summary_large_image">`,
      ].join("\n    ")
    : "";

  return `
    <title>${title} — Keepsake</title>
    <link rel="canonical" href="${url}">
    <meta property="og:type" content="article">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    <meta property="og:url" content="${url}">
    ${imageTags}
  `;
}

itemRoutes.get("/:id", async (c) => {
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

  const tags = buildOgTags({
    title: row.title,
    description: row.story.slice(0, 200),
    url: pageUrl,
    ...(firstPhoto
      ? { image: { url: `${siteUrl}/i/${firstPhoto.id}/full`, width: firstPhoto.width, height: firstPhoto.height } }
      : {}),
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

/**
 * `GET /sitemap.xml` — the four static pages plus every `approved` listing.
 * Mounted at the Worker root and listed in `wrangler.toml`'s
 * `run_worker_first` (like `/item/*`): without that, the static-assets
 * system's `single-page-application` fallback would serve the SPA shell at
 * this path (200, wrong content-type) before this handler ever ran.
 *
 * `given` listings are intentionally omitted — they're still individually
 * reachable (`GET /api/listings/:id`, `/item/:id`) but no longer something
 * a search engine should be pointed at as "available".
 *
 * Served only on production. Every other environment 404s here — see the
 * comment on the handler and `src/routes/robots.ts`.
 */
import { Hono } from "hono";
import type { Env } from "../env.js";
import { isProduction } from "../env.js";

export const sitemapRoutes = new Hono<{ Bindings: Env }>();

const STATIC_PATHS = ["/", "/about", "/privacy", "/terms"];

function escapeXml(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

sitemapRoutes.get("/", async (c) => {
  // Launch audit finding 2: this handler builds every URL from `SITE_URL`,
  // which on preview is the preview host — so preview published a complete,
  // crawlable index of a clone of the product, listing real people's
  // keepsakes under a hostname whose notification email is dropped. Only
  // production has a sitemap worth serving; everywhere else this is a 404,
  // matching `/robots.txt`'s blanket disallow on the same deploys. 404 (not
  // an empty `<urlset/>`) because an empty sitemap is still a live sitemap: a
  // crawler that finds one keeps re-fetching it, and Search Console will
  // happily accept a submission for it.
  if (!isProduction(c.env)) {
    c.header("Content-Type", "text/plain; charset=utf-8");
    c.header("X-Robots-Tag", "noindex, nofollow");
    return c.body("Not found\n", 404);
  }

  const siteUrl = c.env.SITE_URL;
  const now = new Date().toISOString();

  const { results } = await c.env.DB.prepare("SELECT id, updated_at FROM listings WHERE status = 'approved' ORDER BY published_at DESC")
    .all<{ id: string; updated_at: number }>();

  const urls = [
    ...STATIC_PATHS.map((pagePath) => ({ loc: `${siteUrl}${pagePath}`, lastmod: now })),
    ...results.map((row) => ({ loc: `${siteUrl}/item/${row.id}`, lastmod: new Date(row.updated_at).toISOString() })),
  ];

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) => `  <url><loc>${escapeXml(u.loc)}</loc><lastmod>${u.lastmod}</lastmod></url>`),
    "</urlset>",
    "",
  ].join("\n");

  c.header("Content-Type", "application/xml; charset=utf-8");
  // 10 minutes: fresh enough for a new listing to show up in a re-crawl
  // without regenerating this on every single request.
  c.header("Cache-Control", "public, max-age=600");
  return c.body(body);
});

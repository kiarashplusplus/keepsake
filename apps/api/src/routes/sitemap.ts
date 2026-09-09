/**
 * `GET /sitemap.xml` — the public static pages plus every `approved` listing.
 * Mounted at the Worker root and listed in `wrangler.toml`'s
 * `run_worker_first` (like `/item/*`): without that, the static-assets
 * system would answer this path itself — with `dist/404.html` under the
 * `404-page` not-found handling `wrangler.toml` now sets, and with the SPA
 * shell at 200 before that — and this handler would never run.
 *
 * `given` listings are intentionally omitted — they're still individually
 * reachable (`GET /api/listings/:id`, `/item/:id`) but no longer something
 * a search engine should be pointed at as "available".
 *
 * Only the listing URLs carry `<lastmod>`; the static pages carry none. See
 * the comment on that line for why a generated-at timestamp was worse than
 * no timestamp at all.
 *
 * Served only on production. Every other environment 404s here — see the
 * comment on the handler and `src/routes/robots.ts`.
 */
import { Hono } from "hono";
import type { Env } from "../env.js";
import { isProduction } from "../env.js";

export const sitemapRoutes = new Hono<{ Bindings: Env }>();

/**
 * The pages that are worth a crawler's time and are not listings.
 *
 * `/welcome` and `/give` joined the four on 2026-09-09
 * (`docs/runbooks/seo-audit.md`). Both were already public, indexable and
 * `200` on production, and both were unreachable from anywhere a crawler
 * could get to them: the sitemap did not list them, and nothing in the
 * exported HTML of `/`, `/about`, `/privacy` or `/terms` links to either —
 * every one of those is an in-app navigation the client performs, so the
 * only `href`s in the crawlable markup are `/`, `/about`, `/mine`,
 * `/privacy` and `/terms`. `/welcome` is the page that explains what this
 * product is and `/give` is what all three static pages' "Give something"
 * call to action points at, so they were the two most valuable orphans on
 * the site.
 *
 * No trailing slash on `/give`, which is exported as
 * `dist/give/index.html`: `wrangler.toml`'s `html_handling =
 * "drop-trailing-slash"` makes `/give` the URL that answers and `/give/` the
 * one that redirects, matching what `apps/site/public/*.html` already link
 * to and what `apps/web/scripts/seo-html.mjs` writes as its canonical. A
 * sitemap URL that redirects is a URL Google reports as an error.
 *
 * The give flow's interior steps (`/give/story`, `/give/details`,
 * `/give/review`, `/give/email`) are deliberately absent and carry
 * `<meta name="robots" content="noindex, follow">` from the same export
 * script — they are form steps, and a searcher who lands on step three with
 * no state behind it gets a dead end.
 */
const STATIC_PATHS = ["/", "/welcome", "/give", "/about", "/privacy", "/terms"];

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

  const { results } = await c.env.DB.prepare("SELECT id, updated_at FROM listings WHERE status = 'approved' ORDER BY published_at DESC")
    .all<{ id: string; updated_at: number }>();

  // The static pages carry NO `<lastmod>`, and that is the accurate
  // answer rather than a missing one. They used to get `new Date()` — the
  // moment the sitemap was generated — so `/about`, `/privacy` and `/terms`
  // claimed to have changed on every single fetch, ten minutes apart forever,
  // while their bytes had not moved since whenever someone last edited
  // `apps/site/public/*.html`. Google's own sitemap guidance is explicit that
  // `lastmod` must be the last *significant modification* and that it ignores
  // the value when a site reports one that is consistently wrong — which,
  // told at that rate, is a claim that trains a crawler to disregard the
  // dates on the listings below too. Those are real: `listings.updated_at` is
  // the row's own modification time.
  //
  // A true date for the static pages would have to be baked in at build time
  // (the Worker cannot stat a file, and the commit/deploy date is the date
  // the *site* shipped, not the date the page changed). `<lastmod>` is
  // optional in the schema, so omitting it says "I don't know" instead of
  // saying something false — that is the trade, and baking real per-file
  // dates in at export time is the upgrade if these pages ever change often
  // enough to matter.
  const urls: { loc: string; lastmod?: string }[] = [
    ...STATIC_PATHS.map((pagePath) => ({ loc: `${siteUrl}${pagePath}` })),
    ...results.map((row) => ({ loc: `${siteUrl}/item/${row.id}`, lastmod: new Date(row.updated_at).toISOString() })),
  ];

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) => `  <url><loc>${escapeXml(u.loc)}</loc>${u.lastmod === undefined ? "" : `<lastmod>${u.lastmod}</lastmod>`}</url>`),
    "</urlset>",
    "",
  ].join("\n");

  c.header("Content-Type", "application/xml; charset=utf-8");
  // 10 minutes: fresh enough for a new listing to show up in a re-crawl
  // without regenerating this on every single request.
  c.header("Cache-Control", "public, max-age=600");
  return c.body(body);
});

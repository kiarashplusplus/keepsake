/**
 * `GET /robots.txt` — served by the Worker rather than as a static asset, so
 * the answer can depend on which environment is answering.
 *
 * Launch audit finding 2: `apps/web/public/robots.txt` is one file shared by
 * both deploys, so `https://preview.keepsake.ing/robots.txt` served
 * `Allow: /` and `/sitemap.xml` advertised every preview listing under the
 * preview host. That makes preview a crawlable, brand-named clone of the
 * product whose notification email is silently dropped
 * (`EMAIL_MODE=allowlist`, `[env.preview.vars]`) — a stranger who found it in
 * search could post a real keepsake into a database nobody is watching.
 *
 * Production keeps the static file as its copy of record: this handler
 * delegates to the `ASSETS` binding when `ENVIRONMENT === "production"`, so
 * `apps/web/public/robots.txt` remains the one place the production rules are
 * edited. Every other environment gets a blanket disallow generated here.
 *
 * Reaching this handler at all requires `/robots.txt` in `wrangler.toml`'s
 * `run_worker_first` (all three env blocks), for the same reason `/sitemap.xml`
 * is listed there: without it the static-assets system answers first and this
 * code never runs.
 */
import { Hono } from "hono";
import type { Env } from "../env.js";
import { isProduction } from "../env.js";

export const robotsRoutes = new Hono<{ Bindings: Env }>();

/** What every non-production deploy serves. `Disallow: /` is advisory — it
 * asks well-behaved crawlers not to index, which is what robots.txt is for —
 * and the `X-Robots-Tag: noindex, nofollow` header set on every non-production
 * response in `src/index.ts` is the half that actually removes a page already
 * fetched. Neither is access control: preview is still open to anyone with
 * the URL, and Cloudflare Access in front of the preview host is the real fix
 * for that (see docs/runbooks/deploy.md). */
const DISALLOW_ALL = "User-agent: *\nDisallow: /\n";

robotsRoutes.get("/", async (c) => {
  if (isProduction(c.env)) {
    // The production copy lives in `apps/web/public/robots.txt` — one file, in
    // the same place as every other static asset, editable without a Worker
    // deploy's worth of ceremony.
    return c.env.ASSETS.fetch(c.req.raw);
  }

  c.header("Content-Type", "text/plain; charset=utf-8");
  // Short cache: an environment's identity does not change, but a stale
  // `Disallow: /` cached against production would be far worse than a re-fetch.
  c.header("Cache-Control", "public, max-age=600");
  return c.body(DISALLOW_ALL);
});

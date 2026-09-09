/**
 * `not_found_handling` and `html_handling` are the same in every deployed
 * `[assets]` table, and they are the values the rest of the build assumes.
 *
 * Configuration, not behaviour, and it has to be asserted as configuration
 * for the reason `robotsConfig.test.ts` already spells out: miniflare's local
 * assets emulation is driven by `vitest.config.ts`, not by `wrangler.toml`,
 * so the runtime suite would stay green against a file that says something
 * else. Both keys are per-environment and wrangler inherits neither into a
 * named environment, so "set it at the top level and forget the other two"
 * is a real and silent way to ship dev's rules to production.
 *
 * What each value is load-bearing for:
 *
 * - **`404-page`.** `apps/web/scripts/seo-html.mjs` writes `dist/404.html`
 *   for it, `src/index.ts`'s `DYNAMIC_ROUTE_SHELLS` exists only because of
 *   it, and `notFound.test.ts` asserts the status it produces. Back on
 *   `single-page-application` every one of those is dead weight and the
 *   site goes back to answering 200 with the homepage for every URL anyone
 *   invents — measured on production 2026-09-09, see
 *   `docs/runbooks/seo-audit.md`.
 * - **`drop-trailing-slash`.** The one URL shape the canonicals
 *   (`seo-html.mjs`), the sitemap (`routes/sitemap.ts`) and the static
 *   pages' `href="/give"` all assume. Under the default
 *   (`auto-trailing-slash`) `/give` redirects to `/give/` and the sitemap
 *   ships a URL that redirects, which Search Console reports as an error.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ASSETS_TABLES, readAssetsString } from "./wranglerConfig";

const wrangler = (env as unknown as { WRANGLER_TOML_TEXT: string }).WRANGLER_TOML_TEXT;

describe("[assets] not_found_handling / html_handling", () => {
  it("answers a miss with the 404 page in every environment", () => {
    for (const table of ASSETS_TABLES) {
      expect([table, readAssetsString(wrangler, table, "not_found_handling")]).toEqual([table, "404-page"]);
    }
  });

  it("declares one trailing-slash rule in every environment", () => {
    for (const table of ASSETS_TABLES) {
      expect([table, readAssetsString(wrangler, table, "html_handling")]).toEqual([table, "drop-trailing-slash"]);
    }
  });

  it("keeps the local test emulation on the same not-found rule as the deploy", () => {
    // `vitest.config.ts` sets `miniflare.assets.notFoundHandling` by hand —
    // it cannot read this file's value at plugin time without importing it,
    // and the fixture tree is a different directory anyway. This is the
    // assertion that the hand-written copy has not drifted; the same shape
    // as `robotsConfig.test.ts`'s check on `runWorkerFirst`, which exists
    // because that copy really had drifted once (#195).
    const emulated = (env as unknown as { TEST_NOT_FOUND_HANDLING: string }).TEST_NOT_FOUND_HANDLING;
    expect(emulated).toBe(readAssetsString(wrangler, "env.production.assets", "not_found_handling"));
  });
});

/**
 * `test/robots.test.ts` proves the *handler* answers differently per
 * environment. This file proves the handler is reachable at all, which is a
 * separate question and is answered entirely by configuration.
 *
 * `/robots.txt` is a path a static asset also exists at
 * (`apps/web/public/robots.txt` → `apps/web/dist/robots.txt`). Cloudflare's
 * static-assets system answers such a path *before* the Worker unless the
 * path is listed in `run_worker_first` — exactly the reason `/sitemap.xml`
 * and `/health` are already listed. Drop `/robots.txt` from that list in any
 * one environment block and preview silently goes back to serving the
 * production `Allow: /` file, which is launch audit finding 2 all over again,
 * with every unit test still green.
 *
 * That last part is not a guess: removing `/robots.txt` from
 * `vitest.config.ts`'s `runWorkerFirst` and re-running `robots.test.ts` left
 * all four tests passing, because miniflare's local assets emulation does not
 * reproduce the precedence rule. So the runtime suite cannot see this class
 * of mistake, and the configuration has to be asserted directly — the same
 * argument `email-mode-config.test.ts` already makes for `EMAIL_MODE`, and
 * the same `WRANGLER_TOML_TEXT` seam.
 *
 * Issue #84 raised the same question for a bigger set of paths: a literal
 * list only protects the paths someone remembered to add, and `/` itself —
 * the page a searcher actually lands on — was never on it. Dev and preview
 * now use `run_worker_first = true` (every request), which can't go stale
 * the way a list can; production keeps an explicit list for cost reasons, so
 * it's still checked by name, `/admin` included (same issue — advertising it
 * in `robots.txt` was worse than not gating it with the Worker at all).
 *
 * Verified out-of-band against `wrangler dev` (real workerd, real
 * `apps/web/dist`) for `--env preview` and default (dev) with `true`, and
 * `--env production` with the explicit list; see docs/runbooks/deploy.md.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const wrangler = (env as unknown as { WRANGLER_TOML_TEXT: string }).WRANGLER_TOML_TEXT;

function runWorkerFirstBooleans(): string[] {
  return [...wrangler.matchAll(/^run_worker_first\s*=\s*(true)\s*$/gm)].map((m) => m[1] ?? "");
}

function runWorkerFirstLists(): string[] {
  return [...wrangler.matchAll(/^run_worker_first\s*=\s*\[([^\]]*)\]/gm)].map((m) => m[1] ?? "");
}

describe("run_worker_first configuration", () => {
  it("routes every request through the Worker on dev and preview", () => {
    // Top-level [assets] (dev) and [env.preview.assets] — a literal path
    // list is exactly the fragility issue #84 found (it silently excluded
    // `/`), so both use the boolean form instead of a list that can go stale.
    expect(runWorkerFirstBooleans()).toHaveLength(2);
  });

  it("routes /robots.txt, /sitemap.xml and /admin through the Worker on production", () => {
    // [env.production.assets] is the one remaining list — kept narrow on
    // purpose so a hashed static asset request doesn't pay for a Worker hop
    // on the live site.
    expect(runWorkerFirstLists()).toHaveLength(1);
    const [list] = runWorkerFirstLists();
    expect(list).toContain('"/robots.txt"');
    expect(list).toContain('"/sitemap.xml"');
    expect(list).toContain('"/admin"');
  });
});

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
import { productionRunWorkerFirst, readRunWorkerFirst } from "./wranglerConfig";

const wrangler = (env as unknown as { WRANGLER_TOML_TEXT: string }).WRANGLER_TOML_TEXT;
const fixture = JSON.parse(
  (env as unknown as { TEST_RUN_WORKER_FIRST: string }).TEST_RUN_WORKER_FIRST,
) as string[];

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

  it("routes /robots.txt, /sitemap.xml, /admin and /og/* through the Worker on production", () => {
    // [env.production.assets] is the one remaining list — kept narrow on
    // purpose so a hashed static asset request doesn't pay for a Worker hop
    // on the live site.
    expect(runWorkerFirstLists()).toHaveLength(1);
    const [list] = runWorkerFirstLists();
    expect(list).toContain('"/robots.txt"');
    expect(list).toContain('"/sitemap.xml"');
    expect(list).toContain('"/admin"');
    expect(list).toContain('"/og/*"');
  });
});

/**
 * Issue #195. The fixture list in `vitest.config.ts` exists so a path that
 * must beat the static-assets SPA fallback is exercised in tests under the
 * same rule the deployed Worker uses. Two copies of one truth drift, and this
 * one had: `/admin` was added to `[env.production.assets]` (issue #84) and
 * the mirror was never updated, so nothing about `/admin` reaching the Worker
 * ahead of the asset system was actually being exercised — and the suite was
 * green either way.
 *
 * The fixture is now *derived* from the same `wrangler.toml`, so it cannot
 * drift by omission. Note what that does and does not buy: measured while
 * fixing #195, this pool's miniflare ignores `runWorkerFirst` entirely (a
 * fixture asset at `/admin` was served after the Worker ran, identically with
 * the path listed, filtered out, and with the list emptied), so correcting the
 * list changes no test's behaviour today — the same emulation gap this file
 * already records for `/robots.txt`. What it buys is one copy of the truth
 * instead of two. This block is the guard against someone restating it
 * again: it compares the array the running fixture actually booted with
 * (`TEST_RUN_WORKER_FIRST`, injected by `vitest.config.ts` from the very
 * value it passed to `miniflare.assets.runWorkerFirst`) against the list
 * parsed out of the deployed production config.
 */
describe("the vitest run_worker_first fixture mirrors production", () => {
  it("boots with exactly the deployed production list, in order", () => {
    expect(fixture).toEqual(productionRunWorkerFirst(wrangler));
  });

  it("includes /admin", () => {
    // Named separately because this is the path that was missing, and
    // because it is the one whose absence is invisible at runtime:
    // miniflare's local assets emulation does not reproduce the precedence
    // rule, so no other test in this suite can see it.
    expect(fixture).toContain("/admin");
  });

  it("includes /og/*", () => {
    // The share card. Its absence is invisible everywhere except production:
    // dev and preview use `run_worker_first = true`, and miniflare ignores
    // the setting entirely, so `test/ogCard.test.ts` would stay green while
    // every `og:image` in the wild returned the SPA shell as `text/html` —
    // which unfurlers render as a broken image, not as an error. This
    // assertion is the only mechanism in the repo that can catch it.
    expect(fixture).toContain("/og/*");
  });

  it("reads the boolean and list forms, and refuses to guess", () => {
    // The derivation is only a guard if its failure modes are loud. A silent
    // `undefined` here would hand miniflare `runWorkerFirst: undefined` —
    // every path falling through to the assets system, no test able to see
    // it. Synthetic input, so this stays true regardless of what
    // wrangler.toml says today.
    const toml = ['[assets]', 'run_worker_first = true', '', '[env.production.assets]', 'run_worker_first = ["/api/*", "/admin"]'].join("\n");
    expect(readRunWorkerFirst(toml, "assets")).toBe(true);
    expect(productionRunWorkerFirst(toml)).toEqual(["/api/*", "/admin"]);
    expect(() => readRunWorkerFirst(toml, "env.staging.assets")).toThrow(/no \[env\.staging\.assets\]/);
    expect(() => productionRunWorkerFirst('[env.production.assets]\nrun_worker_first = true')).toThrow(
      /explicit path list/,
    );
    expect(readRunWorkerFirst('[env.production.assets]\ndirectory = "../web/dist"', "env.production.assets")).toBeUndefined();
  });
});

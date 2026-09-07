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
 * Verified out-of-band against `wrangler dev` (real workerd, real
 * `apps/web/dist`) for both `--env preview` and `--env production`; see
 * docs/runbooks/deploy.md.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const wrangler = (env as unknown as { WRANGLER_TOML_TEXT: string }).WRANGLER_TOML_TEXT;

function runWorkerFirstLists(): string[] {
  return [...wrangler.matchAll(/^run_worker_first\s*=\s*\[([^\]]*)\]/gm)].map((m) => m[1] ?? "");
}

describe("run_worker_first configuration", () => {
  it("declares one list per environment block", () => {
    // Top-level [assets], [env.preview.assets], [env.production.assets].
    expect(runWorkerFirstLists()).toHaveLength(3);
  });

  it("routes /robots.txt and /sitemap.xml through the Worker in every environment", () => {
    for (const list of runWorkerFirstLists()) {
      expect(list).toContain('"/robots.txt"');
      expect(list).toContain('"/sitemap.xml"');
    }
  });
});

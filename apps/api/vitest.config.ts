import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// `@cloudflare/vitest-pool-workers@0.22` targets Vitest 4, which moved this
// package from the old `defineWorkersConfig({ test: { poolOptions: { workers
// } } })` shape (still documented in a lot of examples, including Bayan's
// `worker/vitest.config.ts` which this file is otherwise modeled on) to a
// Vite plugin: `cloudflareTest(options)` passed to `plugins`, alongside
// vanilla `defineConfig` from `vitest/config`. The package ships a codemod
// (`@cloudflare/vitest-pool-workers/codemods/vitest-v3-to-v4`) confirming
// this is the intended migration, not a workaround.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      // `readD1Migrations` does a real filesystem read, so it has to run out
      // here in the Node/Vite process, not inside `setupFiles` — those run
      // inside the Workers runtime (via `cloudflare:test`), which has no
      // `node:fs`. The parsed migrations travel into the runtime as a plain
      // JSON binding (`TEST_MIGRATIONS`) and `test/setup.ts` applies them
      // with `applyD1Migrations` from `cloudflare:test`.
      const migrations = await readD1Migrations(path.join(__dirname, "migrations"));

      return {
        // The `[ai]` binding has no local emulator in workerd — it always
        // proxies to the real Workers AI API, which is what causes the
        // "AI bindings always access remote resources" warning and a
        // lingering connection that delays (but does not fail) `vitest run`
        // teardown. `remoteBindings: false` keeps D1/R2/KV/assets/ratelimits
        // fully local; AI still goes remote regardless because there is no
        // local alternative, per Cloudflare's own docs. None of the M0 tests
        // call `env.AI.run()`, so this only affects teardown latency, not
        // correctness — left in place (not mocked away) because M1's
        // moderation pipeline tests will want the real binding shape.
        remoteBindings: false,
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // `@cloudflare/vitest-pool-workers@0.22.0` pins its own miniflare
          // (5.20260815.0-alpha), whose bundled workerd binary only supports
          // compatibility dates up to 2026-08-22 — older than wrangler.toml's
          // real `compatibility_date = "2026-09-01"`, which is what `wrangler
          // dev`/`deploy` actually run against via the separately-installed
          // `wrangler@4.129.0`. Overriding it here only affects the test
          // runtime; nothing about the deployed Worker's compatibility date
          // changes. Bump this if a `vitest-pool-workers` upgrade ships a
          // newer bundled workerd.
          compatibilityDate: "2026-08-22",
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Pinned the same way Bayan's `worker/vitest.config.ts` pins its
            // budget vars: so a retune of the real ceilings in wrangler.toml
            // never silently changes what the budget tests assert against.
            ENVIRONMENT: "test",
            COMMIT_SHA: "test-sha",
            MOD_TEXT_DAILY_BUDGET: "1000",
            MOD_IMAGE_DAILY_BUDGET: "3000",
            LISTING_IP_DAILY_BUDGET: "20",
            REQUEST_IP_DAILY_BUDGET: "20",
            UPLOAD_IP_DAILY_BUDGET: "60",
            REPORT_AUTOHIDE_THRESHOLD: "3",
            MAX_PHOTOS: "5",
            MAX_PHOTO_BYTES: "5242880",
            IMAGE_TRANSFORMS_ENABLED: "0",
            EMAIL_PROVIDER: "cf",
            EMAIL_FROM: "Keepsake <hello@keepsake.ing>",
            SITE_URL: "http://localhost:8787",
            MOCK_AI: "1",
          },
          // `../web/dist` (wrangler.toml's real `[assets] directory`) does
          // not exist yet — apps/web hasn't been scaffolded as of this
          // package's M0 work, and this package must typecheck/test on its
          // own. A `serviceBindings: { ASSETS: () => ... }` override was
          // tried first, per the rule to adjust vitest config rather than
          // remove the binding — but the wrangler-config-derived `assets`
          // plugin wins over a same-named `serviceBindings` entry (confirmed
          // by a 404 from the real, missing directory instead of the stub
          // response), so the override has to happen at the same level:
          // `miniflare.assets`, pointed at a fixture directory that lives
          // inside apps/api instead of touching apps/web.
          assets: {
            directory: path.join(__dirname, "test/fixtures/public"),
            binding: "ASSETS",
            notFoundHandling: "single-page-application",
            runWorkerFirst: ["/api/*", "/i/*", "/item/*", "/health", "/version.json"],
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});

import { readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { productionRunWorkerFirst } from "./test/wranglerConfig";

const wranglerTomlText = readFileSync(new URL("./wrangler.toml", import.meta.url), "utf8");

// Issue #195: this list used to be restated here by hand, and had already
// drifted — `/admin` was added to `[env.production.assets]` (issue #84) and
// the copy was not updated, so tests ran under a precedence rule the deployed
// Worker does not use and nothing noticed. Derive it from the one file that
// is deployed instead. `productionRunWorkerFirst` throws if the table is
// renamed or the list becomes the boolean form, so this fails at config time
// rather than quietly reverting the fixture to some other rule.
// `test/robotsConfig.test.ts` asserts the booted value still equals it, which
// is the guard against a future session restating it again.
//
// Do not read this as "and now /admin is exercised under production's
// precedence rule": measured while fixing #195, the miniflare bundled with
// `@cloudflare/vitest-pool-workers@0.22` ignores `runWorkerFirst` outright.
// A fixture asset at `/admin` was answered *after* the Worker ran (the
// non-production `X-Robots-Tag` middleware had already stamped the response)
// identically with `/admin` in the list, with it filtered out, and with the
// list set to `[]`. So in this pool the Worker always runs first and assets
// are only ever reached through the catch-all in `src/index.ts`. That is the
// same limitation `test/robotsConfig.test.ts` records for `/robots.txt`, and
// it is why the drift has to be caught by asserting on configuration:
// nothing at runtime here can see it. Real precedence is only observable
// against real workerd (`wrangler dev --env production`).
const fixtureRunWorkerFirst = productionRunWorkerFirst(wranglerTomlText);

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
        // The `[ai]` binding has no local emulator in workerd. This comment
        // used to claim that AI "still goes remote regardless" of
        // `remoteBindings: false`, because there is no local alternative.
        // That is not what workerd does. With `remoteBindings: false`, an
        // `env.AI.run()` call fails outright:
        //
        //     embed: AI call failed { error: 'Binding AI needs to be run remotely' }
        //
        // (observed directly while wiring up `test/search.test.ts`'s real-AI
        // block — issue #38). It never reaches Cloudflare at all. That was
        // harmless while every test mocked `env.AI.run`, which is why it went
        // unnoticed; it matters now that one test deliberately does not.
        //
        // So this is opt-in rather than a constant: default `false` keeps
        // ordinary runs and CI fully local, deterministic and offline, and
        // `REAL_AI=1` flips it so the real-embeddings test can actually reach
        // Workers AI. Remote bindings also need a Cloudflare credential
        // (`CLOUDFLARE_API_TOKEN`) in the environment — without one, `REAL_AI=1`
        // fails at authentication instead, which is a clearer error than a
        // silently-mocked pass.
        remoteBindings: process.env.REAL_AI === "1",
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
        // Unit tests use a fake EMAIL binding; "test" lets the guard through
        // so the send path is exercised. Never set in wrangler.toml.
        EMAIL_MODE: "test",
        // The config guard test asserts on the real file; the workers runtime
        // has no fs, so it is read here (Node) and passed through.
        WRANGLER_TOML_TEXT: wranglerTomlText,
        // The path list this fixture actually booted with, so a test can
        // compare it against the deployed one (issue #195).
        TEST_RUN_WORKER_FIRST: JSON.stringify(fixtureRunWorkerFirst),
        EMAIL_ALLOWLIST: "",
            TEST_MIGRATIONS: migrations,
            // Pinned the same way Bayan's `worker/vitest.config.ts` pins its
            // budget vars: so a retune of the real ceilings in wrangler.toml
            // never silently changes what the budget tests assert against.
            ENVIRONMENT: "test",
            COMMIT_SHA: "test-sha",
            MOD_TEXT_DAILY_BUDGET: "1000",
            MOD_IMAGE_DAILY_BUDGET: "3000",
            SUGGEST_DAILY_BUDGET: "1000",
            EMBED_DAILY_BUDGET: "2000",
            // Issue #38's kill switch, pinned "0" here so the default test
            // env matches every deployed environment — `test/search.test.ts`
            // turns it on explicitly for the tests that exercise the vector
            // path, and asserts the off behaviour without touching it.
            SEMANTIC_SEARCH: "0",
            // Opt-in escape hatch for the one test that calls *real* Workers
            // AI (`test/search.test.ts`'s "real embeddings" block). Read from
            // the host env out here in Node because the Workers runtime has
            // no `process.env`. Unset means "0", so CI and every ordinary
            // `pnpm test` run stay fully offline and deterministic; a human
            // with Cloudflare credentials runs `REAL_AI=1 pnpm test` to
            // actually look at the model. See that block's comment for why
            // this cannot be a mock.
            REAL_AI: process.env.REAL_AI === "1" ? "1" : "0",
            LISTING_IP_DAILY_BUDGET: "20",
            REQUEST_IP_DAILY_BUDGET: "20",
            UPLOAD_IP_DAILY_BUDGET: "60",
            REPORT_IP_DAILY_BUDGET: "10",
            EMAIL_IP_DAILY_BUDGET: "10",
            SUGGEST_IP_DAILY_BUDGET: "30",
            REPORT_AUTOHIDE_THRESHOLD: "3",
            SHELF_MIN_ITEMS: "3",
            MAX_PHOTO_BYTES: "5242880",
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
            runWorkerFirst: fixtureRunWorkerFirst,
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});

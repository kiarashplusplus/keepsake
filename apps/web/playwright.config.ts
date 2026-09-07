/**
 * Playwright runs against the *real* stack, not a dev server: `wrangler dev`
 * serving the static Expo export (`apps/web/dist`) through the Worker's
 * `[assets]` binding, with local D1/R2/KV. That is the same arrangement
 * production runs, so `/item/:id`'s HTMLRewriter OG injection, the SPA
 * fallback, the `[[ratelimits]]` bindings and the moderation pipeline are all
 * genuinely under test — none of which exist under `expo start`.
 *
 * `MOCK_AI=1` is the one substitution: `src/moderation/{text,image}.ts`
 * short-circuit to a safe/pass verdict without calling Workers AI, so a
 * listing goes `pending -> approved` in milliseconds and the suite costs
 * nothing. It is a `[vars]` entry defaulting to `"0"`, and nothing here
 * changes that default for any deployed environment.
 */
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, PORT } from "./e2e/support/constants";

const API_DIR = path.resolve(__dirname, "../api");
/** Relative to `API_DIR` — both wrangler flags below are resolved from there. */
const STATE_DIR = path.join(".wrangler", "e2e-state");

/**
 * `--env-file` is how the Worker's *secrets* get in: `ADMIN_TOKEN` is not a
 * `[vars]` entry, so `--var` is the wrong instrument, and (verified against
 * wrangler 4.129) passing `--env-file` also stops wrangler reading
 * `apps/api/.dev.vars` at all — which is what keeps a developer's real
 * `TURNSTILE_SECRET` from turning every write in this suite into a 403.
 * `e2e/support/global-setup.mjs` writes that file, immediately before the
 * `&&` below hands over to `wrangler dev`.
 */
const WEB_SERVER_COMMAND = [
  "node ../web/e2e/support/global-setup.mjs",
  [
    // Not `wrangler dev` directly: `serve.mjs` owns the public port and runs
    // wrangler behind it, so a browser hanging up mid-request can't take the
    // dev server down. See that file's header.
    `node ../web/e2e/support/serve.mjs ${PORT} ${PORT + 1} --`,
    "--local",
    "--ip 127.0.0.1",
    `--persist-to ${STATE_DIR}`,
    `--env-file ${path.join(STATE_DIR, "e2e.env")}`,
    "--var MOCK_AI:1",
    `--var SITE_URL:${BASE_URL}`,
    "--log-level warn",
  ].join(" "),
].join(" && ");

export default defineConfig({
  testDir: "./e2e",
  // Every browser spec here is `*.spec.ts`. Playwright's default `testMatch`
  // also collects `*.test.*`, which would sweep up `e2e/support/serve.test.mjs`
  // — a `node --test` suite for the server wrapper, run by
  // `pnpm --filter @keepsake/web test` — and fail on its `node:test` imports.
  testMatch: "**/*.spec.ts",
  // Generous: a cold `wrangler dev` compiles the Worker on the first request,
  // and the give spec walks five steps including a real upload.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // One retry even locally, and `trace: "on-first-retry"` below to make it
  // useful: the only known flake source is `wrangler dev` restarting under
  // e2e/support/serve.mjs, which costs whichever test was mid-request.
  retries: process.env.CI ? 2 : 1,
  // One `wrangler dev` serves every worker, and its D1 is a single local
  // SQLite file; a handful of parallel workers keeps the suite quick without
  // making that the bottleneck.
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI
    ? [["html", { open: "never" }], ["github"], ["list"]]
    : [["html", { open: "never" }], ["list"]],

  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "mobile",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
  ],

  webServer: {
    command: WEB_SERVER_COMMAND,
    cwd: API_DIR,
    url: `${BASE_URL}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});

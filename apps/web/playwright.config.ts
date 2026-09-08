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
    // Estate bulk upload's own kill switch (`apps/api/wrangler.toml`'s
    // `BULK_UPLOAD`) is `"1"` only under `[env.preview]`; this command runs
    // against the *default* (non-preview) `[vars]` block, where it's `"0"` —
    // see that file's comment on why. Left off, `featureFlag(bulkUploadEnabled)`
    // (`src/index.ts`) 404s every `/api/bulk/*` route before any handler
    // runs, so `e2e/bulk.spec.ts` would exercise nothing at all. Verified:
    // with this line absent, both of that spec's tests fail — one waiting
    // 90s for a "Start a new batch" button that never appears (the batch
    // list degrades to its "Not open on this build yet" empty state), the
    // other timing out on the navigation a 404'd `createBatch` never makes.
    "--var BULK_UPLOAD:1",
    "--log-level warn",
  ].join(" "),
].join(" && ");

/**
 * `e2e/ux.spec.ts` writes the committed UX baseline in `docs/qa/baseline/`,
 * and it belongs to neither project above.
 *
 * It runs only under `pnpm --filter @keepsake/web e2e:ux`, which sets
 * `UX_SHOTS`. Two reasons for the switch rather than just another project:
 * an ordinary `pnpm e2e` (or a bare `playwright test` with no `--project`)
 * would otherwise rewrite forty-odd committed frames as a side effect of an
 * unrelated run, and it would do it against a database the functional specs
 * have been posting random listings into all along — so the "feed" baseline
 * would show whatever `browse.spec.ts` happened to create that minute. The
 * capture wants a database holding exactly the fixed catalogue in
 * `e2e/support/demoCatalog.ts` and nothing else, which is also why
 * `webServer.reuseExistingServer` is off below when this is set: a capture
 * always starts its own `wrangler dev` on a freshly wiped `--persist-to`
 * directory rather than borrowing one whose state is unknown.
 */
const UX_SPEC = /ux\.spec\.ts$/;
const CAPTURING_UX = Boolean(process.env.UX_SHOTS);

/**
 * Both capture projects run under `prefers-reduced-motion: reduce`, which is
 * what finally makes the frames comparable.
 *
 * `Print.tsx` drops every card in on a Reanimated spring. That is driven from
 * JavaScript, so Playwright's `animations: "disabled"` never touched it, and a
 * capture landed wherever the spring happened to be: two runs of the same
 * commit differed on 24 of 76 frames — the feed, `/mine`, the item page,
 * every screen with cards on it. Waiting for the pixels to stop moving
 * (`support/shots.ts`) took that to 17; the spring's tail moves less between
 * probes than the comparison can see, so a wait alone cannot close it.
 *
 * Under `reduce`, `Print` initialises `drop` at 1 instead of animating to it,
 * and at `drop === 1` the style is `opacity: 1`, `scale: 1`, full `tiltDeg` —
 * pixel-for-pixel the state the animation was heading for. So this removes
 * the transient without changing the design being photographed, and the
 * frames show what a visitor sees a moment after the page settles either way.
 *
 * It is not set for the functional projects: how the app behaves mid-animation
 * is exactly what a test like `scroll.spec.ts` should keep exercising.
 */
const UX_REDUCED_MOTION = "reduce" as const;

const UX_PROJECTS = CAPTURING_UX
  ? [
      {
        name: "ux-mobile",
        testMatch: UX_SPEC,
        use: {
          ...devices["Desktop Chrome"],
          reducedMotion: UX_REDUCED_MOTION,
          viewport: { width: 390, height: 844 },
          // 2 rather than the `mobile` project's 3: the page still lays out
          // and picks assets as it would on a phone, and `support/shots.ts`
          // writes at `scale: "css"` so the committed file is 390x844 either
          // way. Three would only make the intermediate bitmap bigger.
          deviceScaleFactor: 2,
          isMobile: true,
          hasTouch: true,
        },
      },
      {
        name: "ux-desktop",
        testMatch: UX_SPEC,
        use: {
          ...devices["Desktop Chrome"],
          reducedMotion: UX_REDUCED_MOTION,
          viewport: { width: 1280, height: 800 },
        },
      },
    ]
  : [];

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
      testIgnore: UX_SPEC,
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
      testIgnore: UX_SPEC,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    ...UX_PROJECTS,
  ],

  webServer: {
    command: WEB_SERVER_COMMAND,
    cwd: API_DIR,
    url: `${BASE_URL}/health`,
    reuseExistingServer: !process.env.CI && !CAPTURING_UX,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});

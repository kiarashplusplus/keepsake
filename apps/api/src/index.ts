import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { captureException, configureCapture } from "@keepsake/observability/capture";
import { apiErr } from "@keepsake/contracts/common";
import { assertBindings, isProduction, type Env } from "./env.js";
import { moderationRetry } from "./cron/moderationRetry.js";
import { orphanSweep } from "./cron/orphanSweep.js";
import { ukBlock } from "./middleware/ukBlock.js";
import { securityHeaders } from "./middleware/securityHeaders.js";
import { geoRoutes } from "./routes/geo.js";
import { photoRoutes } from "./routes/photos.js";
import { listingRoutes } from "./routes/listings.js";
import { meRoutes } from "./routes/me.js";
import { imageRoutes } from "./routes/images.js";
import { feedRoutes } from "./routes/feed.js";
import { itemRoutes } from "./routes/item.js";
import { robotsRoutes } from "./routes/robots.js";
import { sitemapRoutes } from "./routes/sitemap.js";
import { recoverRoutes } from "./routes/recover.js";
import { adminRoutes } from "./routes/admin.js";
import { requestWithdrawRoutes } from "./routes/requestWithdraw.js";

type Variables = {
  requestId: string;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Every response carries the id it was handled under, so a report from a
// giver ("it said something went wrong") can be matched to a log line
// without either side reading the body of an error response to each other.
app.use("*", async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  // Every capture call below (this file, listings.ts, moderation/pipeline.ts,
  // cron/moderationRetry.ts) reads `service`/`environment`/`release` from
  // here rather than taking them as arguments — see
  // `@keepsake/observability/capture`'s own comment on why a module-level
  // set-once value is safe for these three in particular. Set unconditionally
  // on every request, before anything downstream has a chance to throw.
  configureCapture({ service: "keepsake-api", environment: c.env.ENVIRONMENT, release: c.env.COMMIT_SHA });
  await next();
  c.header("X-Request-Id", requestId);

  // Launch audit finding 2. `robots.txt` is a request a crawler may or may
  // not make; this header travels on the response it already has, and is the
  // half that gets a preview URL *removed* from an index rather than merely
  // asking not to be added to one. Set on every non-production response, not
  // just HTML: `/item/:id`'s OG shell, `/i/:id/:variant` photos and the JSON
  // API are all indexable surfaces, and image search is exactly how a
  // stranger's keepsake photo would surface from a host nobody is watching.
  if (!isProduction(c.env)) {
    c.header("X-Robots-Tag", "noindex, nofollow");
  }
});

// Issue #24. `wrangler.toml` checks in `COMMIT_SHA = "dev"` as the value
// every environment falls back to if nothing overrides it — correct for
// local `wrangler dev`, where there is no real commit to stamp, but a lie by
// omission in `production`: `deploy.yml`'s automated path always passes
// `--var COMMIT_SHA:${{ github.sha }}` so this never fires through CI, but a
// hand-run `wrangler deploy --env production` — exactly the thing reached
// for when CI itself is broken, the moment an accurate commit matters most —
// silently ships `"dev"` if the operator forgets the flag, and `/health`
// would report it as fact. `.github/workflows/uptime.yml` already catches
// this from the outside within ~15 minutes, but that is a monitor watching a
// symptom, not a guard on the thing that produces it, and it does nothing
// for whoever is staring at their terminal right after running the bad
// command. This is the guard: mounted as the very first middleware (ahead of
// every route, including `/health` and `/version.json` themselves) so
// *every* response in `production` refuses outright the instant this
// misconfiguration exists, rather than quietly serving traffic under a false
// commit until the next monitor tick. `isProduction` keeps `preview` and
// local dev exempt on purpose — `"dev"` is the correct, expected value
// everywhere except the one environment real users and incident response
// depend on. See docs/runbooks/deploy.md#manual-deploys-and-commit_sha-issue-24.
app.use("*", async (c, next) => {
  if (isProduction(c.env) && c.env.COMMIT_SHA === "dev") {
    console.error('commit-sha guard: refusing to serve production traffic with COMMIT_SHA="dev"');
    return c.json(
      apiErr(
        "unavailable",
        'Production refuses to serve traffic: COMMIT_SHA is still "dev". This means ' +
          "`wrangler deploy --env production` ran without `--var COMMIT_SHA:$(git rev-parse HEAD)`. " +
          "Redeploy with that flag — see docs/runbooks/deploy.md#manual-deploys-and-commit_sha-issue-24.",
      ),
      503,
    );
  }
  await next();
});

// Issue #10 — see src/middleware/securityHeaders.ts for what this sets and
// why. Mounted globally, and *before* the UK block below, so the headers it
// sets after `next()` land on every response family this Worker can produce
// — including the UK block's own 451 explanation page — not just the ones
// that reach routing. It covers `/item/:id`'s OG-injected HTML and every
// `/api/*` JSON response, neither of which `apps/web/public/_headers`
// (applied only by the Cloudflare assets binding) ever touches.
app.use("*", securityHeaders());

// Mounted early, before any route: see src/middleware/ukBlock.ts and
// docs/runbooks/uk-block.md. Reads and writes both, `/api/*` and the SPA
// shell alike — nothing behind this line should ever see a UK visitor.
app.use("*", ukBlock());

app.onError((err, c) => {
  const status: ContentfulStatusCode = err instanceof HTTPException ? err.status : 500;
  console.error("unhandled error", {
    requestId: c.get("requestId"),
    path: c.req.path,
    status,
    error: err instanceof Error ? err.message : String(err),
  });
  // Hono's own `onError` already turns every thrown error into a normal JSON
  // response, and Workers Logs (`[observability]` in wrangler.toml) only
  // captures an exception automatically if it's actually *uncaught* — once
  // `onError` handles it, nothing propagates for the platform to see. This
  // explicit call is what gets the error into the same structured capture
  // shape as every other `captureException` call, tagged with the request id
  // above so it can be matched back to whatever the giver saw.
  captureException(err, { tags: { requestId: c.get("requestId"), path: c.req.path } });
  // Every code here must be one of `@keepsake/contracts/common`'s
  // `ERROR_CODES` — this is the catch-all for anything a route didn't
  // already turn into a proper `fail(...)` response via `src/lib/respond.ts`,
  // so "internal" (an unexpected failure) is the only honest code for it.
  return c.json(apiErr("internal", err.message), status);
});

app.get("/health", async (c) => {
  const { ok: bindingsOk, checks: bindingChecks } = assertBindings(c.env);

  // A dedicated read past `assertBindings`' presence check: the D1 binding
  // can exist and still be unreachable (wrong database_id, D1 outage), and
  // that's the failure mode `/health` exists to catch.
  let d1: "ok" | "error";
  try {
    await c.env.DB.prepare("SELECT 1").first();
    d1 = "ok";
  } catch (err) {
    console.error("health: D1 check failed", { error: err instanceof Error ? err.message : String(err) });
    d1 = "error";
  }

  // Same idea as the D1 check above, for R2: `assertBindings`' `BUCKET`
  // check only proves the binding exists, not that R2 will actually answer a
  // request (wrong bucket name, R2 refusing reads). `head()` on a sentinel
  // key that almost certainly doesn't exist is the cheapest real operation
  // available — a `null` result still means R2 itself answered and is
  // exactly the expected outcome, so only a thrown error grades `"error"`.
  let r2: "ok" | "error";
  try {
    await c.env.BUCKET.head("__health/sentinel");
    r2 = "ok";
  } catch (err) {
    console.error("health: R2 check failed", { error: err instanceof Error ? err.message : String(err) });
    r2 = "error";
  }

  // Same idea again, for KV: a `get()` returning `null` (key absent) still
  // proves KV answered; only a thrown error grades `"error"`.
  let kv: "ok" | "error";
  try {
    await c.env.KV.get("health:sentinel");
    kv = "ok";
  } catch (err) {
    console.error("health: KV check failed", { error: err instanceof Error ? err.message : String(err) });
    kv = "error";
  }

  // Neither secret's presence nor absence is ever put in the response body
  // by name — only this rolled-up "ok"/"degraded" verdict — and only in
  // `production`. Local dev and preview routinely run without Turnstile/
  // admin provisioned yet (see `.dev.vars.example`); that shouldn't make
  // their `/health` look unhealthy the way it must once traffic is real.
  const secretsConfigured = Boolean(c.env.TURNSTILE_SECRET) && Boolean(c.env.ADMIN_TOKEN);
  const secrets: "ok" | "degraded" = !isProduction(c.env) || secretsConfigured ? "ok" : "degraded";

  const checks = { ...bindingChecks, d1, r2, kv, secrets };
  const ok = bindingsOk && d1 === "ok" && r2 === "ok" && kv === "ok";
  const degraded = secrets === "degraded";
  const commit = c.env.COMMIT_SHA ?? "dev";

  return c.json(
    {
      ok,
      degraded,
      commit,
      env: c.env.ENVIRONMENT,
      // Same shape `/version.json` returns, inlined here too so a single
      // `/health` fetch is enough to confirm which build answered — no
      // second round trip needed just to double-check the commit.
      version: { commit, environment: c.env.ENVIRONMENT },
      checks,
    },
    ok ? 200 : 503,
  );
});

app.get("/version.json", (c) => {
  // Never cached: this is exactly what apps/web's version-skew guard polls to
  // notice a new deploy, so a stale cached copy would defeat the point.
  c.header("Cache-Control", "no-store");
  return c.json({ commit: c.env.COMMIT_SHA ?? "dev" });
});

app.route("/api/geo", geoRoutes);
app.route("/api/photos", photoRoutes);
app.route("/api/listings", listingRoutes);
app.route("/api/me", meRoutes);
app.route("/api/feed", feedRoutes);
app.route("/api/recover", recoverRoutes);
app.route("/api/requests", requestWithdrawRoutes);
app.route("/api/admin", adminRoutes);
app.route("/i", imageRoutes);
// Mounted at the Worker root, per the plan's route table — not under /api/*,
// and reached at all only because wrangler.toml's `run_worker_first` lists
// these exact paths, overriding the static-assets system that would
// otherwise serve them as SPA-shell/404 before this Worker code ever runs.
app.route("/item", itemRoutes);
app.route("/sitemap.xml", sitemapRoutes);
// Same deal as `/sitemap.xml`: reached only because `run_worker_first` lists
// `/robots.txt`, so this handler answers instead of the static asset that
// also exists at that path. Production delegates straight back to that asset;
// see `routes/robots.ts`.
app.route("/robots.txt", robotsRoutes);

app.all("/api/*", (c) => c.json({ ok: false as const, error: { code: "not_found", message: "Not found" } }, 404));

// Everything else — the SPA shell, hashed static assets, `/item/:id` (M2
// will layer HTMLRewriter OG injection on top of this same fetch) — is
// served by the `ASSETS` binding. Only the HTML document is forced to
// `no-store`; hashed `/_expo/static/*` assets keep whatever immutable
// caching header the assets binding already set, untouched.
app.all("*", async (c) => {
  const assetResponse = await c.env.ASSETS.fetch(c.req.raw);
  const contentType = assetResponse.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    return assetResponse;
  }

  const headers = new Headers(assetResponse.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(assetResponse.body, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers,
  });
});

/**
 * Runs one cron job to completion and makes a failure *visible*.
 *
 * Launch audit finding 12: both jobs used to be handed to
 * `ctx.waitUntil(...)` and the handler returned immediately. Two things
 * followed from that, and neither was survivable. `@sentry/cloudflare`'s
 * scheduled instrumentation used to wrap this handler, so it had already
 * resolved by the time the job did any work — its `finally` disposed the
 * client while the job was still running, and a rejection inside
 * `orphanSweep` or `moderationRetry` became a detached unhandled rejection
 * with nothing to catch it. And Cloudflare judges a cron invocation by
 * whether the handler resolved, so a job that threw every single night still
 * reported as a successful run, forever, in silence.
 *
 * Awaiting instead fixes both: the exception now propagates all the way out
 * of `scheduled` (an uncaught exception here is captured by Workers Logs —
 * `[observability]` in wrangler.toml — automatically, no SDK needed), this
 * function additionally captures it with the job's name attached (so the log
 * line says which cron, not just "scheduled"), and rethrowing marks the
 * invocation failed in the Cloudflare dashboard. The heartbeat each job
 * writes as its last statement (`cron:last:<name>` in KV) stays the positive
 * signal — `GET /api/admin/health` turns a stale one into `ok: false`.
 *
 * `ctx` is still passed and used for `waitUntil`, so the job keeps running if
 * the request context is torn down early — belt and braces, not either/or.
 */
async function runCron(name: string, job: (env: Env) => Promise<void>, env: Env, ctx: ExecutionContext): Promise<void> {
  // `scheduled` (below) never touches the `app.use("*", ...)` middleware
  // above — it isn't an HTTP request — so this is the only place a cron
  // invocation gets `service`/`environment`/`release` configured before any
  // job it runs might call `captureException`/`captureMessage`.
  configureCapture({ service: "keepsake-api", environment: env.ENVIRONMENT, release: env.COMMIT_SHA });
  const started = Date.now();
  const running = job(env);
  ctx.waitUntil(running);
  try {
    await running;
    console.log("scheduled: done", { cron: name, durationMs: Date.now() - started });
  } catch (err) {
    console.error("scheduled: failed", {
      cron: name,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    });
    captureException(err, { tags: { cron: name } });
    // Rethrow so the invocation is recorded as failed by the platform too —
    // the capture above is the alert, the dashboard is the audit trail, and
    // a job that silently "succeeded" while doing nothing is the exact
    // failure mode this whole function exists to remove.
    throw err;
  }
}

async function scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  switch (controller.cron) {
    case "*/5 * * * *":
      await runCron("moderationRetry", moderationRetry, env, ctx);
      break;
    case "17 3 * * *":
      await runCron("orphanSweep", orphanSweep, env, ctx);
      break;
    default:
      console.warn("scheduled: unrecognized cron pattern", { cron: controller.cron });
  }
}

/** Exported for `test/cron.test.ts`: the scheduled handler is not reachable
 * through `SELF.fetch`, and the property under test — a throwing job is
 * captured and rethrown rather than swallowed — is not observable from
 * anywhere else. */
export { runCron };

// No more `Sentry.withSentry(...)` wrapper (issue #14 — `@sentry/cloudflare`
// removed entirely): this is the same `{ fetch, scheduled }` shape Cloudflare
// expects from a Worker's default export, just not instrumented by an SDK
// that never had a DSN to send through. Workers Logs (`[observability]` in
// wrangler.toml) captures uncaught exceptions from either handler on its
// own, no wrapping required.
export default {
  fetch: app.fetch,
  scheduled,
};

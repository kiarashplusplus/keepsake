import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { captureException, configureCapture } from "@keepsake/observability/capture";
import { apiErr } from "@keepsake/contracts/common";
import { assertBindings, isProduction, semanticSearchEnabled, type Env } from "./env.js";
import { dailyDigest } from "./cron/dailyDigest.js";
import { moderationRetry } from "./cron/moderationRetry.js";
import { orphanSweep } from "./cron/orphanSweep.js";
import { errorEventSweep } from "./cron/errorEventSweep.js";
import { searchIndexRetry } from "./cron/searchIndexRetry.js";
import { bulkRunner } from "./cron/bulkRunner.js";
import { type CronJobName, writeCronHeartbeat } from "./cron/registry.js";
import { ukBlock } from "./middleware/ukBlock.js";
import { securityHeaders } from "./middleware/securityHeaders.js";
import { geoRoutes } from "./routes/geo.js";
import { photoRoutes } from "./routes/photos.js";
import { bulkRoutes } from "./routes/bulk.js";
import { listingRoutes } from "./routes/listings.js";
import { meRoutes } from "./routes/me.js";
import { imageRoutes } from "./routes/images.js";
import { feedRoutes } from "./routes/feed.js";
import { itemRoutes } from "./routes/item.js";
import { robotsRoutes } from "./routes/robots.js";
import { ogCardRoutes } from "./routes/ogCard.js";
import { sitemapRoutes } from "./routes/sitemap.js";
import { recoverRoutes } from "./routes/recover.js";
import { adminRoutes } from "./routes/admin.js";
import { requestWithdrawRoutes } from "./routes/requestWithdraw.js";
import { requestConfirmRoutes } from "./routes/requestConfirm.js";

type Variables = {
  requestId: string;
};

/**
 * Paths that are never worth a search engine's attention because their
 * contents require a credential the crawler cannot have — see the
 * `X-Robots-Tag` middleware below for why each one is here. Kept as one
 * list read by both `isNoindexPath` and, indirectly, `test/robots.test.ts`,
 * so a route added to one place cannot silently disagree with the other.
 */
const NOINDEX_PATH_PREFIXES = ["/admin", "/bulk", "/mine", "/recover", "/withdraw", "/confirm"];

/** True for `prefix` itself and every path nested under it (`/admin`,
 * `/admin/anything`), never for a merely similarly-named sibling
 * (`/administer` does not match `/admin`). */
function isNoindexPath(path: string): boolean {
  return NOINDEX_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

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
  //
  // Issue #84, extended by #278: also noindex a fixed set of private-ish
  // paths unconditionally, including in production — not just `/admin`.
  // `apps/web/public/robots.txt` used to `Disallow: /admin` alone, which
  // stops a well-behaved crawler from *fetching* a page but does nothing
  // about one some other link already got indexed, and — worse — hands
  // anyone who reads a public, unauthenticated file a free pointer at the
  // endpoints worth attacking (#84's reasoning, which is why this stays a
  // header rather than growing `robots.txt` into an itemised list). The
  // token/owner-token gate on each of these routes is the actual security
  // boundary and is unchanged either way; this only keeps the page out of
  // search results without advertising that it exists.
  //
  // `NOINDEX_PATH_PREFIXES` covers every route whose contents are reachable
  // only with a credential the crawler doesn't have — `/admin` (token),
  // `/bulk*` and `/mine*` (owner token, and `/bulk/<client_batch_key>` is
  // meant to be known only to the device that minted it), `/recover*`,
  // `/withdraw*` and `/confirm*` (a mailed, single-use token in the path
  // itself, so indexing one is a worse leak than the others: search engines
  // do crawl URLs they merely see linked, not only ones a sitemap lists).
  // `/item/*` and the feed root stay indexable on purpose — they're the
  // content this product wants found. A prefix match, not `===`, because
  // `/admin` matching only itself was the same "list only protects what
  // someone remembered" mistake #84 already found once for `robots.txt`:
  // any future `/admin/...` or `/bulk/<key>/review` needs no new line here.
  //
  // Reaching any of these at all on production requires them in
  // `wrangler.toml`'s `[env.production.assets] run_worker_first` — see that
  // file's comment and `test/robotsConfig.test.ts`, which is what actually
  // proves the Worker (and so this header) is reached rather than the
  // static-assets system answering first.
  if (!isProduction(c.env) || isNoindexPath(c.req.path)) {
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

/**
 * What may go into a log field describing where a request was headed.
 *
 * Issue #182: `path: c.req.path` wrote the concrete URL path into a bare
 * `console.error` (no redaction at all) and into a `captureException` tag
 * (where `redactDeep` leaves it alone, because the key is `path`). The
 * recovery token used to be a path segment, so a giver clicking their
 * emailed link during any request that threw put a live account-takeover
 * credential into Workers Logs, which keeps every line
 * (`head_sampling_rate = 1` in all three env blocks).
 *
 * The route shape is fixed — the token is in the POST body now, matching
 * `POST /api/requests/withdraw` — but the log field is the half that has to
 * stay safe when someone adds the *next* token-bearing route. So log the
 * matched route **pattern** (`/api/listings/:id`) rather than the value:
 * a pattern is a string we wrote, so it cannot carry a caller's secret, and
 * it is the more useful thing to group errors by anyway. Hono only knows the
 * pattern once routing has picked a handler; a request that threw in a `*`
 * middleware, or matched nothing, gets `"(unrouted)"` rather than a fallback
 * to the raw path — the fallback would be the leak, and `requestId` is
 * already logged beside this for tying a report back to one request.
 *
 * The complementary fix — teaching `redactString` about secrets in path
 * segments generally — is #170, and lives in
 * `packages/observability/src/redact.ts`. Deliberately not duplicated here.
 */
function logRoutePattern(c: { req: { routePath?: string } }): string {
  const pattern = c.req.routePath;
  if (typeof pattern !== "string" || pattern === "" || pattern === "*" || pattern === "/*") {
    return "(unrouted)";
  }
  return pattern;
}

app.onError((err, c) => {
  const status: ContentfulStatusCode = err instanceof HTTPException ? err.status : 500;
  const route = logRoutePattern(c);
  console.error("unhandled error", {
    requestId: c.get("requestId"),
    route,
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
  captureException(err, { tags: { requestId: c.get("requestId"), route } });
  // Every code here must be one of `@keepsake/contracts/common`'s
  // `ERROR_CODES` — this is the catch-all for anything a route didn't
  // already turn into a proper `fail(...)` response via `src/lib/respond.ts`,
  // so "internal" (an unexpected failure) is the only honest code for it.
  // Keep the exception itself in the log and capture above, but never copy
  // its message into the public response: backend errors can contain SQL,
  // binding names, provider details, or credentials. Routes with a message
  // deliberately written for a giver return `fail(...)` before reaching
  // this unexpected-error boundary.
  return c.json(apiErr("internal", "Something went wrong. Please try again."), status);
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

  // Same idea again, for ASSETS — issue #191. `assertBindings` only proves
  // the binding object exists, and `/health` is answered by Worker code, not
  // by the assets binding, so a deploy whose web export produced a broken or
  // partial `dist/` used to verify green: `deploy.yml`'s only post-deploy
  // check is that `/health` reports the right commit, and that check ran
  // across exactly this gap while the site served nothing usable.
  //
  // The probe is a real fetch of the SPA shell through the binding, and it
  // names `/index.html` — a file that must exist in any usable export —
  // rather than relying on a fallback. It used to lean on one: under
  // `not_found_handling = "single-page-application"` any path at all came
  // back as `index.html`, so the probe could not tell a served shell from a
  // substituted one. Under `404-page` (2026-09-09) a non-`ok` status means
  // there is genuinely no shell, which is the failure worth catching and is
  // what this was always meant to say.
  //
  // Verified against real workerd rather than assumed, because
  // `html_handling = "drop-trailing-slash"` redirects an incoming
  // `/index.html` request to `/`: a `wrangler dev` `/health` reports
  // `assets: "ok"`, so the binding resolves the file by path and the
  // trailing-slash rules do not apply to a direct binding fetch. Miniflare's
  // assets emulation would not have shown a difference either way.
  //
  // The URL's origin is irrelevant to the binding (it routes on path) but
  // must be well-formed, so it is written literally rather than derived from
  // the incoming request, whose path is `/health`.
  let assets: "ok" | "error";
  try {
    const shell = await c.env.ASSETS.fetch(new Request("https://assets.invalid/index.html"));
    // Drain the body: an undrained response body in workerd holds the stream
    // open for the lifetime of the request.
    await shell.arrayBuffer();
    assets = shell.ok ? "ok" : "error";
    if (!shell.ok) {
      console.error("health: ASSETS check failed", { status: shell.status });
    }
  } catch (err) {
    console.error("health: ASSETS check failed", { error: err instanceof Error ? err.message : String(err) });
    assets = "error";
  }

  // Vectorize, issue #191. This binding appeared in no health field and no
  // Observatory panel at all, while `search/vectorize.ts` returns silently
  // when it is absent — so a rollback across a binding change or a
  // hand-edited `[[vectorize]]` block reverts semantic search to FTS with
  // nothing anywhere saying so, while `SEMANTIC_SEARCH="1"` and the privacy
  // page both keep asserting the feature is running.
  //
  // Three states, not two, for the reason AGENTS.md gives about the
  // Observatory's panels: a field that cannot tell "I did not look" from "I
  // looked and saw nothing" is another check that cannot fail.
  //
  //   ok      — the binding is there. (Not a query: a real Vectorize read
  //             costs an embedding call, which is the same objection that
  //             keeps `AI` presence-only. Presence is the honest ceiling
  //             here and this comment is the record of that choice.)
  //   error   — SEMANTIC_SEARCH is on and the binding is absent. Search is
  //             silently running as FTS while every other surface claims
  //             otherwise. This one fails `ok`.
  //   off     — the kill switch is off and there is no binding. A supported
  //             configuration, and explicitly not a fault.
  const vectorize: "ok" | "error" | "off" = c.env.VECTORIZE ? "ok" : semanticSearchEnabled(c.env) ? "error" : "off";
  if (vectorize === "error") {
    console.error("health: SEMANTIC_SEARCH is on but the VECTORIZE binding is absent — search has silently fallen back to FTS");
  }

  // Neither secret's presence nor absence is ever put in the response body
  // by name — only this rolled-up "ok"/"degraded" verdict — and only in
  // `production`. Local dev and preview routinely run without Turnstile/
  // admin provisioned yet (see `.dev.vars.example`); that shouldn't make
  // their `/health` look unhealthy the way it must once traffic is real.
  const secretsConfigured = Boolean(c.env.TURNSTILE_SECRET) && Boolean(c.env.ADMIN_TOKEN);
  const secrets: "ok" | "degraded" = !isProduction(c.env) || secretsConfigured ? "ok" : "degraded";

  const checks = { ...bindingChecks, d1, r2, kv, assets, vectorize, secrets };
  const ok = bindingsOk && d1 === "ok" && r2 === "ok" && kv === "ok" && assets === "ok" && vectorize !== "error";
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
// Estate bulk upload (docs/design/bulk-upload.md). Its own router-level
// `featureFlag(bulkUploadEnabled)` answers 404 — never 403 — everywhere the
// flag is off, so a tier that has not enabled the pilot is indistinguishable
// from one where the feature does not exist.
app.route("/api/bulk", bulkRoutes);
app.route("/api/listings", listingRoutes);
app.route("/api/me", meRoutes);
app.route("/api/feed", feedRoutes);
app.route("/api/recover", recoverRoutes);
app.route("/api/requests", requestWithdrawRoutes);
app.route("/api/requests", requestConfirmRoutes);
app.route("/api/admin", adminRoutes);
app.route("/i", imageRoutes);
// Mounted at the Worker root, per the plan's route table — not under /api/*,
// and reached at all only because wrangler.toml's `run_worker_first` lists
// these exact paths, overriding the static-assets system that would
// otherwise serve them as SPA-shell/404 before this Worker code ever runs.
app.route("/item", itemRoutes);
// The share card (`/og/item/:id/card.png`) — same `run_worker_first` caveat.
// Without `/og/*` in production's list this returns the SPA shell as
// `text/html`, which every unfurler renders as a broken image, and dev and
// preview (`run_worker_first = true`) cannot reproduce it. Asserted by
// `test/wranglerConfig.test.ts`, since miniflare ignores the setting.
app.route("/og", ogCardRoutes);
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
//
// Issue #272: `#262` turned on route splitting (`asyncRoutes`), so a route's
// JS now arrives as its own content-hashed chunk under this prefix instead
// of in the one entry bundle, and a deploy replaces those hashes. A tab left
// open across a deploy that navigates to a route it hasn't already loaded
// requests a chunk that no longer exists, and the browser must not be handed
// HTML where a JS module was expected — the dynamic import rejects with
// "Unexpected token '<'", which tells nobody what happened. Under the
// `single-page-application` not-found handling this was written for, that
// HTML was the shell at 200; under `404-page` (see below) it is the 404 page
// at 404, still `text/html`. Both are wrong here, and both are answered the
// same way: a plain, uncached 404 the client's chunk-load recovery
// (`apps/web/src/features/chunkRecovery/useChunkRecoveryGuard.ts`) can tell
// apart from an ordinary network failure.
const CHUNK_PATH_PREFIX = "/_expo/static/";

/**
 * The exported HTML shell for each app route whose path contains a
 * parameter. Matched in order; every pattern is anchored at both ends, so
 * the order is for reading rather than for precedence.
 *
 * `wrangler.toml`'s `[assets]` blocks answer a miss with `404-page` rather
 * than `single-page-application` (that file's comment has the measurement
 * that prompted it: every unexported path on production answered `200` with
 * the homepage's bytes). A miss is now genuinely a miss — which is right for
 * `/no-such-page` and wrong for `/mine/<a real id>`, whose path Expo Router
 * exported as the literal filename `dist/mine/[id].html` and which the
 * assets system therefore cannot match.
 *
 * So these routes are served their own shell explicitly. That is not merely
 * restoring the old behaviour: the SPA fallback handed back `index.html` —
 * the *feed's* markup, header, search field, category chips and all — so a
 * hard refresh of `/mine/abc` painted the feed for the moment before
 * hydration replaced it. `routes/item.ts` already fixed exactly this for
 * `/item/:id` when the exported bodies stopped being empty
 * (`docs/runbooks/seo-audit.md`, second pass); this is the same fix for the
 * five routes that were left.
 *
 * `/item/:id` is absent because `routes/item.ts` owns it and reads
 * `dist/item/[id].html` itself, with the listing's OG tags and inline
 * payload spliced in. `/bulk/:batchKey`'s three steps are enumerated rather
 * than globbed so that `/bulk/<key>/nonsense` still 404s.
 *
 * Reaching this code at all on production requires each prefix in
 * `[env.production.assets] run_worker_first`; every one of them is already
 * there for the `X-Robots-Tag` middleware, and `test/robotsConfig.test.ts`
 * is what holds that.
 */
const DYNAMIC_ROUTE_SHELLS: readonly (readonly [RegExp, string])[] = [
  [/^\/mine\/[^/]+$/, "/mine/[id].html"],
  [/^\/recover\/[^/]+$/, "/recover/[token].html"],
  [/^\/withdraw\/[^/]+$/, "/withdraw/[token].html"],
  [/^\/confirm\/[^/]+$/, "/confirm/[token].html"],
  [/^\/bulk\/[^/]+$/, "/bulk/[batchKey]/index.html"],
  [/^\/bulk\/[^/]+\/photos$/, "/bulk/[batchKey]/photos.html"],
  [/^\/bulk\/[^/]+\/review$/, "/bulk/[batchKey]/review.html"],
  [/^\/bulk\/[^/]+\/submit$/, "/bulk/[batchKey]/submit.html"],
];

/**
 * The shell path for `path`, or `null` when nothing dynamic serves it.
 *
 * The square brackets are Expo Router's own filenames and are percent-encoded
 * for the same reason `routes/item.ts` encodes them: they are not legal in a
 * URL path unencoded, and the assets binding decodes them before matching.
 *
 * `/mine` and `/mine/email` (and `/recover`, `/bulk`, `/bulk/new`) are real
 * exported files, so they never reach here — the assets fetch matched them.
 */
function dynamicShellPath(path: string): string | null {
  for (const [pattern, shell] of DYNAMIC_ROUTE_SHELLS) {
    if (pattern.test(path)) {
      return shell.replace(/\[([^\]]+)\]/g, (_, name: string) => encodeURIComponent(`[${name}]`));
    }
  }
  return null;
}

app.all("*", async (c) => {
  let assetResponse = await c.env.ASSETS.fetch(c.req.raw);

  // A dynamic app route (`/mine/:id`, `/bulk/:batchKey/review`, …) has no
  // file at its own path — Expo Router exported it under the literal
  // `[param]` filename — so under `404-page` handling the fetch above misses.
  // Fetch the route's own shell instead of letting that 404 out. See
  // `DYNAMIC_ROUTE_SHELLS`.
  if (assetResponse.status === 404) {
    const shell = dynamicShellPath(c.req.path);
    if (shell !== null) {
      assetResponse = await c.env.ASSETS.fetch(new Request(new URL(shell, c.req.url), { headers: c.req.raw.headers }));
    }
  }

  const contentType = assetResponse.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    return assetResponse;
  }

  // Nothing under `_expo/static/*` is ever legitimately HTML — it's
  // route-split JS chunks, source maps and fonts, all content-hashed
  // filenames from a single build. So a `text/html` response under this
  // prefix is never the file the request actually asked for; it can only be
  // the page the assets binding substitutes for a miss (`dist/404.html`
  // today, the SPA shell before `404-page` handling).
  // Answering that truthfully (a real 404, uncached) is what lets the
  // client's chunk-load recovery
  // (`apps/web/src/features/chunkRecovery/useChunkRecoveryGuard.ts`) tell
  // "this needs a reload" apart from an ordinary network failure, and turns
  // the failure into a plain 404 in the network panel instead of a parse
  // error.
  if (c.req.path.startsWith(CHUNK_PATH_PREFIX)) {
    return new Response("Not found", {
      status: 404,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
    });
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
 * invocation failed in the Cloudflare dashboard.
 *
 * **The heartbeat is written here** (`cron:last:<name>` in KV), after the
 * job's promise resolves and before this returns — that is the positive
 * signal `GET /api/admin/health` turns into `ok: false` once it goes stale.
 * Issue #165: this docblock and `cron/registry.ts` both already said so while
 * each job wrote its own key instead, and `dailyDigest` — added last — wrote
 * none. A never-written key is stale by definition, so the endpoint answered
 * `ok: false` on every deployed tier permanently and the digest's subject was
 * permanently "N needs attention". Centralizing the write is what makes a
 * fourth cron impossible to add without one: the job author no longer writes
 * a heartbeat at all, the dispatcher does, and `name` is typed against the
 * registry so a job dispatched under a name no `staleAfterMs` covers does not
 * compile.
 *
 * On failure nothing is written, deliberately — a job that threw did not do
 * its job, and the whole value of the key is that it means "finished".
 *
 * `ctx` is still passed and used for `waitUntil`, so the job keeps running if
 * the request context is torn down early — belt and braces, not either/or.
 */
async function runCron(name: CronJobName, job: (env: Env) => Promise<void>, env: Env, ctx: ExecutionContext): Promise<void> {
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
    await writeCronHeartbeat(env.KV, name, Date.now());
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
    case "23 * * * *":
      await runCron("searchIndexRetry", searchIndexRetry, env, ctx);
      break;
    case "17 3 * * *":
      await runCron("orphanSweep", orphanSweep, env, ctx);
      break;
    case "7 0 * * *":
      await runCron("dailyDigest", dailyDigest, env, ctx);
      break;
    case "*/3 * * * *":
      await runCron("bulkRunner", bulkRunner, env, ctx);
      break;
    case "41 3 * * *":
      await runCron("errorEventSweep", errorEventSweep, env, ctx);
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

/** Exported for `test/writeSurfaceTurnstile.test.ts` (#246): `app.routes` is
 * Hono's own registration table, built from every `app.route(...)` mount
 * above with each sub-router's paths already merged onto its real prefix —
 * the one place the *actual* non-GET `/api/*` write surface can be read back
 * from, rather than re-derived by hand and risking a second list that drifts
 * from this file the way the routes themselves once drifted from Turnstile
 * coverage. */
export { app };

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

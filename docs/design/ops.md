# Ops

Status: `[IN PROGRESS]` (preflight + CI landed in M0; Worker-side observability + admin API +
orphan sweep landed in M4 2026-09-06, see below; web-side Analytics/runbooks/e2e are still M4–M5).

## CI shape

`changes` (dorny/paths-filter) gates everything downstream by what actually moved; `preflight`
always runs regardless (cheapest, catches the most); `lint`/`typecheck` skip on docs-only
changes; `test-packages`/`test-api`/`test-web` are scoped to their area (plus `packages`, since a
shared-package change can break either app); `build-web` and `e2e` cascade-skip automatically
whenever what they depend on skipped. See `.github/workflows/ci.yml`. `e2e` is wired up but
`if: false` until Playwright specs exist (M4).

## Deploy

`.github/workflows/deploy.yml` runs on every PR and every push to `main` (→ `preview` in both
cases) and, separately, on a manual `workflow_dispatch` where a human picks `production` — merging
to `main` never ships production by itself (fixed 2026-09-07, issue #13; this previously said
"push to main → production", which matched neither `deploy.yml`'s actual trigger logic nor
`docs/runbooks/deploy.md`). Gated on `vars.DEPLOY_ENABLED == 'true'` so it's inert until the
Cloudflare resources exist. Steps: export the web bundle with that environment's
`EXPO_PUBLIC_*` vars baked in → apply D1 migrations `--remote` → `wrangler deploy` with
`--var COMMIT_SHA:<sha>` → `curl /health` and assert `.commit == github.sha` → comment the
preview URL on PRs. See [`docs/runbooks/deploy.md`](../runbooks/deploy.md) for the manual setup
steps (secrets, D1/R2/KV creation, Turnstile, Email Service onboarding), the real
`wrangler rollback` invocation, and the `COMMIT_SHA` fallback's contract.

## Preflight

`tools/preflight/preflight.mjs` — zero-dependency, seconds-fast, checks that don't need a
running Worker: font references vs files on disk, migration numbering, `.env.example` ↔
`wrangler.toml` parity (and that no secret leaks into a committed `[vars]` block), `@cf/` model
ids confined to `models.ts`, package `exports` (no `"."` barrel), route files export a default,
no merge-conflict markers, no unfetched LFS pointers, `EXPO_PUBLIC_*` names are never secrets,
`bash -n` on every shell script. Every check reports `skip` rather than `fail` when its target
path doesn't exist yet — useful during active scaffolding, strict once everything lands. Modeled
on Bayan's `tools/ci/preflight.py`, including "every check is tested against both a working and
a broken fixture" (`preflight.test.mjs`).

## Observability

**Workers Logs, not Sentry** (issue #14, 2026-09-06). The original plan was `@sentry/cloudflare`
on the Worker and `@sentry/react` on the web client, both routed through
`@keepsake/observability/redact`. It shipped half-built: `SENTRY_DSN` needs a Sentry account only
Kiarash can create, so it was never set on either environment, and `buildSentryOptions` returning
`undefined` made every `Sentry.captureException`/`captureMessage` call a silent no-op — the
auto-hide alert, the cron-failure alert, every unhandled route error, all going nowhere (launch
audit finding 4). `@sentry/react` was never even added to `apps/web`.

The fix Kiarash asked for was a Cloudflare-native alternative rather than waiting on an account:
**Workers Logs**, enabled via `[observability]` in `apps/api/wrangler.toml` (`enabled = true`,
`head_sampling_rate = 1`), available on the Free plan. It captures uncaught exceptions
automatically, no SDK or client needed. `packages/observability/src/capture.ts` replaces the old
`@sentry/*` call sites with `captureException(err, opts?)` / `captureMessage(message, level,
opts?)` — plain functions that write one structured object to `console.error`/`console.warn`
(objects, not `JSON.stringify`'d strings, so Workers Logs can index and filter on individual
fields like `tags.cron`). Every message/tag/extra/error still runs through
`@keepsake/observability/redact`'s `redactDeep`/`redactString` first — that redaction is the part
of the original Sentry work worth keeping, and it survived the SDK's removal unchanged.
`SENSITIVE_KEY_RE` covers `cf-turnstile-response` and `idempotency[-_]?key` alongside the
originals. `POST /api/admin/test-error` (`src/routes/admin.ts`, `adminAuth()`-guarded) exists
purely to prove an event actually lands against a real deployment — a unit test asserting
`captureException`'s return value can't tell you that.

**Why this over Sentry:** no third-party account or secret to provision (removes the blocker
outright), and one fewer subprocessor that ever sees error data — it stays inside Cloudflare, the
platform already hosting the app.

**What's lost, honestly:** the Free plan's Workers Logs retains events for **3 days**, versus
Sentry's much longer history. There is **no alerting or push notification** — nobody's phone buzzes
when an error lands, the same "no notification that would wake him" gap launch-audit finding 4
originally described, just without a DSN to blame anymore. There is **no issue grouping or release
tracking** — every event is a flat log line, not a deduplicated, trending issue. A **Tail Worker or
Logpush** could push events somewhere alerting *is* possible; that is a real follow-up, not
something built here — see `docs/runbooks/incident.md`.

Cloudflare Web Analytics is unrelated to any of this and unaffected: cookieless and storage-free,
so no consent banner is needed for it; the privacy page says so explicitly rather than leaving it
implied.

## Health checks

`/health` performs a real operation per binding, not a presence check: `SELECT 1` on D1, a
`head()` on R2, a `get()` on KV. A `null` result from either of the last two still grades `ok` —
an absent key proves the service answered, and only a thrown error is a failure. `AI` stays
presence-only on purpose: a real inference on every health poll would draw down the same daily
moderation budget #18 flags as exhaustible. `EMAIL` stays presence-only and grades `degraded`
rather than failing the whole check.

`GET /api/admin/health` is the separate, authenticated signal: it grades each cron's
`cron:last:<name>` heartbeat against `CRON_STALE_AFTER_MS` (30 min for `moderationRetry`, 26 h
for `orphanSweep`), counts a never-run cron as stale, and folds that into `ok`. The admin stats
strip renders it, so a stopped cron is visible on the page rather than only in logs.

## Security headers

Set in two places because they cover disjoint responses. `apps/web/public/_headers` is read only
by the Cloudflare assets binding, so it covers the SPA shell and static files;
`src/middleware/securityHeaders.ts` covers what that binding never touches — `/item/:id`'s
rewritten HTML and every `/api/*` JSON response. The CSP string is duplicated verbatim between
them rather than shared: they are consumed by unrelated runtimes with no common module, and
`/item/:id` serves the real exported shell, so a stricter policy on the Worker side would break
theming on that one route. `script-src` is hash-based rather than `'unsafe-inline'`. If the
pre-hydration theme script's text ever changes, its hash goes stale silently — nothing in the
suite currently protects that pair.

## Version skew

**`[PARTIAL]`, corrected 2026-09-06 (issue #23)** — this section used to describe the guard as
shipped ("ported from Finderly's `useVersionSkewGuard`"). It wasn't: nothing in `apps/web`
referenced `/version.json` at all, so a tab left open across a deploy ran its stale bundle
indefinitely with nothing telling it otherwise.

What's actually true today:

- **Server (`apps/api`, done):** `GET /version.json` returns `{ commit: "<full SHA>" }`, always
  `Cache-Control: no-store`, and is in `wrangler.toml`'s `run_worker_first` list so a cached
  static asset at that path can never shadow the live one. `commit` is `COMMIT_SHA`, stamped by
  `deploy.yml` with the full `github.sha` at deploy time — see `apps/api/test/health.test.ts`.
- **Build-time plumbing (`apps/web`, done but unused):** `app.config.js` bakes a commit hash into
  `expo.extra.buildInfo.commitHash` via `scripts/resolveBuildInfo.mjs`, and
  `scripts/write-version-json.mjs` writes a static `dist/version.json` next to the export.
  Neither is read by anything at runtime yet — they're the ingredients for a guard, not the guard.
- **The guard itself (`apps/web`, not done):** no polling, no comparison, no reload prompt exists
  anywhere in the client. This is the actual client-side port of Finderly's
  `useVersionSkewGuard`, and it's still unbuilt. See issue #23's closing comment for the exact
  contract (including a real gotcha: the baked-in `commitHash` is a **7-character prefix** of the
  full SHA `/version.json` returns, so the comparison needs `startsWith`, not `===`).

## M4 status (API side, 2026-09-06)

`[DONE]` — `apps/api`'s M4 slice: the default export (`src/index.ts`) is a plain
`{ fetch, scheduled }` object; Workers Logs (`[observability]` in `wrangler.toml`) captures
uncaught exceptions on its own, and `captureException`/`captureMessage`
(`@keepsake/observability/capture`, see "Observability" above) cover the handled cases, both
still routed through `@keepsake/observability/redact`. `SENSITIVE_KEY_RE`
(`packages/observability/src/redact.ts`) extended with `idempotency[-_]?key`
(`cf-turnstile-response`/`turnstile` were already there). `GET /health` gained `degraded` +
`version` fields — `degraded` fires only in `production` and only when `TURNSTILE_SECRET` or
`ADMIN_TOKEN` is unset, never naming which. Admin API (`src/routes/admin.ts` +
`src/middleware/adminAuth.ts`, constant-time token compare, `RL_ADMIN`-limited) and a real
`orphanSweep` cron (photos >24h orphaned, `recovery_tokens` >7d expired,
`moderation_events`/`email_events` >90d old) replace their M0 stubs — see
[`docs/runbooks/admin.md`](../runbooks/admin.md). `packages/contracts/src/admin.ts` extended
additively (`AdminQueueItem` now carries `owner`/`report_count`/`events`/`reports`; the old
bare-`OwnerListing` shape had no callers to break). The `/admin` page itself and Playwright `e2e`
are not part of this slice.

## Launch-audit fixes (2026-09-06)

Four things in this document's territory changed after the launch audit
([`docs/runbooks/launch-audit.md`](../runbooks/launch-audit.md)):

- **Crons are awaited, not detached.** `scheduled` used to hand both jobs to `ctx.waitUntil(...)`
  and return, so `@sentry/cloudflare`'s scheduled instrumentation (in place at the time) had
  already resolved — and disposed its client — before the job did any work. A rejection was a
  detached unhandled rejection nothing caught, and Cloudflare recorded the invocation as a success
  because the handler it was watching resolved. `runCron()` in `src/index.ts` now awaits, captures
  with a `cron` tag, and rethrows. `moderationRetry` additionally catches per listing, so one
  poisoned row no longer aborts the batch, skips the heartbeat and repeats identically every five
  minutes forever.
- **`GET /api/admin/health` reads its own heartbeats.** `cron:last:<name>` was written correctly
  and returned correctly, and then ignored: `ok` came from `postal_codes_count > 0` alone. It is
  now false when either heartbeat is stale (30 min for `moderationRetry`, 26 h for `orphanSweep`).
- **There is an uptime check.** `.github/workflows/uptime.yml` — every 15 minutes, `/health` on
  preview and (once `PRODUCTION_LIVE` is set) production, with a JSON assertion on `ok`, an error
  annotation, and a deduplicated issue on failure. Before this, `.github/workflows/` held two
  files and neither had a `schedule:` trigger.
- **There is a documented restore path.** [`docs/runbooks/restore.md`](../runbooks/restore.md).
  Note the finding buried in it: `wrangler d1 export` **fails on this database** — `cannot export
  databases with Virtual Tables (fts5)` — so any backup has to name its tables with `--table`.

The "None of the Sentry-side work means anything until `SENTRY_DSN` is set" caveat that used to
live here is gone along with `SENTRY_DSN` itself — issue #14 replaced Sentry with Workers Logs,
which needs no secret and no account, so every `captureException`/`captureMessage` call above is
live as soon as the Worker deploys. See "Observability" above for what that switch cost.

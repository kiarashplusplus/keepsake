# Ops

Status: `[IN PROGRESS]` (preflight + CI landed in M0; Worker-side Sentry + admin API + orphan
sweep landed in M4 2026-09-06, see below; web-side Sentry/Analytics/runbooks/e2e are still M4–M5).

## CI shape

`changes` (dorny/paths-filter) gates everything downstream by what actually moved; `preflight`
always runs regardless (cheapest, catches the most); `lint`/`typecheck` skip on docs-only
changes; `test-packages`/`test-api`/`test-web` are scoped to their area (plus `packages`, since a
shared-package change can break either app); `build-web` and `e2e` cascade-skip automatically
whenever what they depend on skipped. See `.github/workflows/ci.yml`. `e2e` is wired up but
`if: false` until Playwright specs exist (M4).

## Deploy

`.github/workflows/deploy.yml` runs on every PR (→ `preview` environment) and every push to
`main` (→ `production`), gated on `vars.DEPLOY_ENABLED == 'true'` so it's inert until the
Cloudflare resources exist. Steps: export the web bundle with that environment's
`EXPO_PUBLIC_*` vars baked in → apply D1 migrations `--remote` → `wrangler deploy` with
`--var COMMIT_SHA:<sha>` → `curl /health` and assert `.commit == github.sha` → comment the
preview URL on PRs. See [`docs/runbooks/deploy.md`](../runbooks/deploy.md) for the manual setup
steps (secrets, D1/R2/KV creation, Turnstile, Email Service onboarding).

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

`@sentry/cloudflare` (Worker) and `@sentry/react` (web), both routed through
`@keepsake/observability/redact` before anything leaves the process — ported from Finderly's
`initSentry.ts` redaction (no lookbehind, since it has to run everywhere including engines that
don't support it), `SENSITIVE_KEY_RE` extended with `cf-turnstile-response`. `tracesSampleRate 0`
and no session replay — replay would capture uploaded photos and story text. Cloudflare Web
Analytics is cookieless and storage-free, so no consent banner is needed for it; the privacy page
says so explicitly rather than leaving it implied.

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

Ported from Finderly's `useVersionSkewGuard`: the exported `index.html` and `/version.json` are
served `no-store`; hashed assets are immutable. A stale client polling `/version.json` detects a
new deploy and prompts a reload rather than silently running against an API contract the server
has moved past.

## M4 status (API side, 2026-09-06)

`[DONE]` — `apps/api`'s M4 slice: `@sentry/cloudflare` `withSentry()` wraps the default export
(`src/index.ts`), instrumenting both `fetch` and `scheduled` from one call; `beforeSend`/
`beforeBreadcrumb` go through `@keepsake/observability/redact` via a `buildSentryOptions(env)`
helper that returns `undefined` (no client, no network) whenever `SENTRY_DSN` is unset.
`SENSITIVE_KEY_RE` (`packages/observability/src/redact.ts`) extended with `idempotency[-_]?key`
(`cf-turnstile-response`/`turnstile` were already there). `GET /health` gained `degraded` +
`version` fields — `degraded` fires only in `production` and only when `TURNSTILE_SECRET` or
`ADMIN_TOKEN` is unset, never naming which. Admin API (`src/routes/admin.ts` +
`src/middleware/adminAuth.ts`, constant-time token compare, `RL_ADMIN`-limited) and a real
`orphanSweep` cron (photos >24h orphaned, `recovery_tokens` >7d expired,
`moderation_events`/`email_events` >90d old) replace their M0 stubs — see
[`docs/runbooks/admin.md`](../runbooks/admin.md). 41 new API-side tests (149 total in
`apps/api`); `packages/contracts/src/admin.ts` extended additively (`AdminQueueItem` now carries
`owner`/`report_count`/`events`/`reports`; the old bare-`OwnerListing` shape had no callers to
break). Web-side Sentry, the `/admin` page itself, and Playwright `e2e` are not part of this
slice.

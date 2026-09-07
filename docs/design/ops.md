# Ops

Status: `[DONE]` for M0–M4 — preflight and CI landed in M0; Worker-side observability, the admin
API and the orphan sweep landed in M4 (2026-09-06, see below); Playwright `e2e`, Web Analytics,
the `/admin` page and the runbooks have all landed since. What is *not* done is push alerting:
nothing wakes anyone up, by design and by omission both — see "Observability" below and
[`docs/product-decisions.md`](../product-decisions.md).

## CI shape

`changes` (dorny/paths-filter) gates everything downstream by what actually moved; `preflight`
always runs regardless (cheapest, catches the most); `lint`/`typecheck` skip on docs-only
changes; `test-packages`/`test-api`/`test-web` are scoped to their area (plus `packages`, since a
shared-package change can break either app); `build-web` and `e2e` cascade-skip automatically
whenever what they depend on skipped. See `.github/workflows/ci.yml`.

**`e2e` runs.** This paragraph used to end "`e2e` is wired up but `if: false` until Playwright
specs exist (M4)" — that stopped being true when the suite landed, and the sentence outlived it.
The job now runs `pnpm --filter @keepsake/web e2e` (84 specs, mobile and desktop) on every pull
request that touches what it depends on. Two live caveats: it is gated by the same `changes`
scoping as everything else, so an **api-only** pull request never runs it (#147, open — the exact
mirror of the "the e2e job had never once executed" row in `AGENTS.md`'s table), and each merge to
`main` gets its own CI run only because #103 changed the concurrency group — pushes now key on
`github.run_id` with `cancel-in-progress: false`, so back-to-back merges queue instead of
cancelling each other. Before that, `cancelled` is neither red nor green, nothing reads it, and
three merged commits shipped to preview untested.

## Deploy

`.github/workflows/deploy.yml` runs on **every push to `main`** (→ `preview`) and, separately, on
a manual `workflow_dispatch` where a human picks `production` — merging to `main` never ships
production by itself (fixed 2026-09-07, issue #13; this previously said "push to main →
production", which matched neither `deploy.yml`'s actual trigger logic nor
`docs/runbooks/deploy.md`).

**Pull requests deploy nowhere** (#73, which also resolved #66). This paragraph said "every PR and
every push to `main`" until 2026-09-07 and was wrong for exactly as long as the trigger had been
gone; verify a branch with `pnpm --filter @keepsake/web e2e` instead, and see
`docs/runbooks/deploy.md#verifying-against-preview`.

Gated on `vars.DEPLOY_ENABLED == 'true'` so it's inert until the Cloudflare resources exist.
Steps: export the web bundle with that environment's `EXPO_PUBLIC_*` vars baked in → apply D1
migrations `--remote` → `wrangler deploy` with `--var COMMIT_SHA:<sha>` → `curl /health` and
assert `.commit == github.sha`. (A fifth step used to comment the preview URL on the pull request;
it went with the `pull_request:` trigger.)

See [`docs/runbooks/deploy.md`](../runbooks/deploy.md) for the manual setup steps (secrets,
D1/R2/KV creation, Turnstile, Email Service onboarding), the real `wrangler rollback` invocation,
and the `COMMIT_SHA` fallback's contract.

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
of the original Sentry work worth keeping, and it outlived the SDK — minus the two Sentry-shaped wrappers,
`redactEvent` and `redactBreadcrumb`, which went with it. **Redaction is credential-shaped
only:** `SENSITIVE_KEY_RE` and `KEY_VALUE_NAMES` are lists of key and token names, and
`redactDeep` matches on key name, so an email address or phone number — the only PII Keepsake
holds — is not matched anywhere, and one sitting in a message string, a stack or an unrecognised
`extra` key reaches Workers Logs verbatim (#170).
`SENSITIVE_KEY_RE` covers `cf-turnstile-response` and `idempotency[-_]?key` alongside the
originals. `POST /api/admin/test-error` (`src/routes/admin.ts`, `adminAuth()`-guarded) exists
purely to prove an event actually lands against a real deployment — a unit test asserting
`captureException`'s return value can't tell you that.

**Why this over Sentry:** no third-party account or secret to provision (removes the blocker
outright), and one fewer subprocessor that ever sees error data — it stays inside Cloudflare, the
platform already hosting the app.

**What's lost, honestly:** the Free plan's Workers Logs retains events for **3 days**, versus
Sentry's much longer history. There is **no push notification** — nobody's phone buzzes
when an error lands. (Not quite "no alerting": the daily digest emailed to `ADMIN_DIGEST_TO` at
00:07 UTC carries a `needs_attention` list covering stale crons and budget exhaustion, and
`cron/dailyDigest.ts` calls itself an alerting channel. It is a once-a-day pull, not a page.)
This is the same "no notification that would wake him" gap launch-audit finding 4
originally described, just without a DSN to blame anymore. There is **no issue grouping or release
tracking** — every event is a flat log line, not a deduplicated, trending issue. A **Tail Worker or
Logpush** could push events somewhere alerting *is* possible; that is a real follow-up, not
something built here — see `docs/runbooks/incident.md`.

Cloudflare Web Analytics is unrelated to any of this and unaffected: cookieless and storage-free,
so no consent banner is needed for it; the privacy page says so explicitly rather than leaving it
implied.

## Health checks

`/health` performs a real operation per binding, not a presence check: `SELECT 1` on D1, a
`head()` on R2, a `get()` on KV, and — since #191 — a real `fetch()` of the SPA shell through
`ASSETS`. A `null` result from the R2/KV probes still grades `ok` — an absent key proves the
service answered, and only a thrown error is a failure; the assets probe grades on the response
status, because `deploy.yml`'s only post-deploy verification is that `/health` reports the right
commit, and `/health` is answered by Worker code rather than by the assets binding. A deploy over
a broken or partial `dist/` used to verify green while the site served nothing usable.

`vectorize` is a fourth field with **three** states rather than two, for the same reason the
Observatory's Cloudflare panels have three: `ok` (binding present), `error` (`SEMANTIC_SEARCH` is
on and the binding is absent — search has silently reverted to FTS while the var and the privacy
page both still say it is running; this fails `ok`), and `off` (the kill switch is off and there
is no binding, a supported configuration and not a fault). It is presence rather than a query
because a real Vectorize read costs an embedding call.

`AI` stays presence-only on purpose: a real inference on every health poll would draw down the
same daily moderation budget #18 flags as exhaustible. `EMAIL` stays presence-only and grades
`degraded` rather than failing the whole check — a real read there is a delivered message, and
`POST /api/admin/test-email` is the on-demand version. Both reasons are written down beside
`assertBindings` in `src/env.ts` so the next audit does not re-file them.

`GET /api/admin/health` is the separate, authenticated signal: it grades each cron's
`cron:last:<name>` heartbeat against the `staleAfterMs` recorded per job in
`src/cron/registry.ts` (30 min for `moderationRetry`, 26 h for `orphanSweep` **and
`dailyDigest`** — three registered crons, not two), counts a never-run cron as stale, and folds
that into `ok` along with `report_pressure.autohidden_awaiting_review`. `CRON_STALE_AFTER_MS` no
longer exists on the API side; the only identifier by that name left is the web mirror in
`StatsStrip.tsx`. Every heartbeat is written in one place — `runCron` in `index.ts`, after the
job's promise resolves and never when it throws — so a cron cannot be registered without one
(#165, where `dailyDigest` wrote none and pinned this signal to `ok: false` on every deployed
tier). The admin stats strip renders it, so a stopped cron is visible on the page rather than only
in logs.

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

**`[DONE]`, closed 2026-09-07 (issue #23)** — this section used to describe the guard as shipped
("ported from Finderly's `useVersionSkewGuard`") while the client half didn't exist, then (as of
2026-09-06) was corrected to say so honestly and left `[PARTIAL]`. The client half is now built.

What's actually true today:

- **Server (`apps/api`, done):** `GET /version.json` returns `{ commit: "<full SHA>" }`, always
  `Cache-Control: no-store`, and is in `wrangler.toml`'s `run_worker_first` list so a cached
  static asset at that path can never shadow the live one. `commit` is `COMMIT_SHA`, stamped by
  `deploy.yml` with the full `github.sha` at deploy time — see `apps/api/test/health.test.ts`.
  Verified against real bytes, not just the test: `curl` against a local `wrangler dev` returned
  `{"commit":"dev"}` with `Cache-Control: no-store` and no other caching header.
- **Build-time plumbing (`apps/web`, done):** `app.config.js` bakes a commit hash into
  `expo.extra.buildInfo.commitHash` via `scripts/resolveBuildInfo.mjs`, and
  `scripts/write-version-json.mjs` writes a static `dist/version.json` next to the export. Both
  are now actually read — `src/lib/buildInfo.ts` is the one place `expo-constants` gets pulled at
  runtime.
- **The guard itself (`apps/web`, done):** `src/features/versionSkew/useVersionSkewGuard.ts`
  polls `GET /version.json` (`cache: "no-store"`, belt-and-braces on top of the server's own
  header) on mount, every 5 minutes on an interval, and on window focus/tab-visible — capped to
  once per minute so switching tabs isn't chatty. `src/lib/versionSkew.ts`'s `isVersionStale`
  compares with `startsWith`, not `===` — the baked-in `commitHash` is a **7-character prefix**,
  `/version.json`'s `commit` is the full SHA, and either side reading `"dev"` (no `COMMIT_SHA`
  stamped — local dev, or a preview build without it) skips the comparison instead of nagging
  every session. `responseIsCacheable` explicitly checks the response's own `Cache-Control` header
  and `console.warn`s once if it's ever missing `no-store` — the exact class of dead check this
  document's other sections have caught before, made to fail loudly instead of just being trusted.
  `src/features/versionSkew/VersionSkewBanner.tsx` (mounted once, in `app/_layout.tsx`) shows a
  dismissible strip — never a modal, never an automatic `location.reload()` — so it can't pull the
  page out from under someone mid-story in the give flow or mid-note in `RequestSheet`; reload only
  happens when the visitor presses the button.
- **Proof it can fail:** `isVersionStale`'s `startsWith` was temporarily swapped for `===` (the
  exact bug this section used to describe) and the "matches" test in
  `test/lib/versionSkew.test.ts` / `test/features/versionSkew/useVersionSkewGuard.test.tsx` failed
  as expected — a real deploy's full SHA never equals the build's 7-character prefix, so that
  regression would have shown the banner on every single page load. Reverted; suite green again.

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
  now false when any of the three heartbeats is stale (30 min for `moderationRetry`, 26 h for
  `orphanSweep` and `dailyDigest`).
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

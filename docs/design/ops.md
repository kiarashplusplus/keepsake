# Ops

Status: `[IN PROGRESS]` (preflight + CI landed in M0; Sentry/Analytics/runbooks are M4–M5).

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

## Version skew

Ported from Finderly's `useVersionSkewGuard`: the exported `index.html` and `/version.json` are
served `no-store`; hashed assets are immutable. A stale client polling `/version.json` detects a
new deploy and prompts a reload rather than silently running against an API contract the server
has moved past.

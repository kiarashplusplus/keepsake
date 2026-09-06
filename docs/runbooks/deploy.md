# Runbook: deploy

Status: current for M0; secrets/DNS steps below are one-time setup, not per-deploy.

## Environments

| Environment | Trigger | Worker | Data |
|---|---|---|---|
| preview | every PR (`.github/workflows/deploy.yml`) | one shared Worker | its own D1/R2/KV — never production's |
| production | push to `main` | `keepsake.ing` | production D1/R2/KV |

Both are gated on the `DEPLOY_ENABLED` repository/environment variable being `"true"`; until the
Cloudflare resources below exist, leave it unset (or `"false"`) so the workflow is a no-op.

## One-time Cloudflare setup

Run once per environment (`preview`, `production`), from `apps/api/`:

```sh
# D1
wrangler d1 create keepsake-db-preview
wrangler d1 create keepsake-db-production
# → paste the returned database_id into wrangler.toml [env.<name>.d1_databases]

# R2
wrangler r2 bucket create keepsake-photos-preview
wrangler r2 bucket create keepsake-photos-production

# KV
wrangler kv namespace create KV --env preview
wrangler kv namespace create KV --env production
# → paste the returned id into wrangler.toml [env.<name>.kv_namespaces]

# Apply schema, then load the postal-code seed (see docs/runbooks/geodata.md)
wrangler d1 migrations apply keepsake-db --env preview --remote
wrangler d1 execute keepsake-db --env preview --remote --file ../api/seeds/postal_codes.sql
```

Turnstile: create a widget per domain (preview subdomain, `keepsake.ing`) in the Cloudflare
dashboard; the site key is public (`EXPO_PUBLIC_TURNSTILE_SITE_KEY`), the secret is not
(`TURNSTILE_SECRET`).

Email Service: onboard `keepsake.ing` as a verified sender domain for Cloudflare Email Service
(account enablement is unverified as of the build plan — confirm with `wrangler dev --remote`
against the `[[send_email]]` binding before relying on it; `/health` reports `EMAIL: degraded`
rather than failing if it isn't working yet).

DNS: point `keepsake.ing` at the Worker via a route/custom domain in the Cloudflare dashboard,
once `wrangler deploy --env production` has run at least once.

## Secrets

Set per environment, never committed (see root `.env.example`'s `# secrets:` block):

```sh
wrangler secret put TURNSTILE_SECRET --env preview
wrangler secret put ADMIN_TOKEN --env preview
wrangler secret put SENTRY_DSN --env preview
wrangler secret put RESEND_API_KEY --env preview   # fallback provider only
# repeat with --env production
```

`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` are GitHub Environment secrets (Settings →
Environments → preview/production), used only by `deploy.yml` to run `wrangler` in CI — they are
not Worker secrets and are never passed to `wrangler secret put`.

## What a deploy actually does

1. `pnpm install --frozen-lockfile`
2. `pnpm --filter @keepsake/web export` with that environment's `EXPO_PUBLIC_*` values baked in
3. `wrangler d1 migrations apply keepsake-db --env <env> --remote`
4. `wrangler deploy --env <env> --var COMMIT_SHA:<sha>`
5. `curl <site>/health` and assert `.commit == github.sha` — a deploy that doesn't match its own
   commit fails the workflow rather than silently serving stale code.

## Rollback

`wrangler deploy --env <env> --var COMMIT_SHA:<previous-sha>` after checking out the previous
commit — there is no separate rollback command; a rollback is just a deploy of an older ref.
Migrations are additive and forward-only (per plan), so rolling back code does not roll back
schema; check a failing migration's compatibility with the previous code before rolling back
across one.

## Account-side prerequisites still owed (as of 2026-09-06)

These need the Cloudflare dashboard (the wrangler OAuth token lacks the scopes). Until they are done, preview runs with Turnstile in soft-pass and email disabled.

1. **Email Service: onboard `keepsake.ing`.** Preview currently logs `send_failed: could not find domain config of sending domain` in `email_events`. Dashboard → Email → Email Service → Sending domains → add `keepsake.ing`, let Cloudflare add the DKIM/SPF/DMARC records, wait for "Verified". Sender is `hello@keepsake.ing` (`EMAIL_FROM`); no mailbox is needed for sending. Re-test: `POST /api/me/email` on preview, then `SELECT error FROM email_events ORDER BY created_at DESC LIMIT 1`.
2. **Turnstile widget.** Dashboard → Turnstile → Add widget → hostnames `keepsake.ing`, `preview.keepsake.ing`, `keepsake-preview.leapkg.workers.dev`; mode Managed. Then `wrangler secret put TURNSTILE_SECRET --env preview` (and `--env production`), and set `EXPO_PUBLIC_TURNSTILE_SITE_KEY` in the GitHub Environment vars (it is public by design).
3. **DNS / routes.** `preview.keepsake.ing` → Worker `keepsake-preview` (Workers & Pages → keepsake-preview → Settings → Domains & Routes → add custom domain). Apex `keepsake.ing` → Worker `keepsake` (production) when M5 cuts over. Then flip `SITE_URL` in `wrangler.toml` `[env.preview.vars]` back to `https://preview.keepsake.ing`.
4. **GitHub Environments `preview` and `production`.** Secrets `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit, D1:Edit, Workers KV:Edit, Workers R2:Edit, Account Settings:Read), `CLOUDFLARE_ACCOUNT_ID=dc6a87ed4a4269ed74c8f508b275b703`; vars `EXPO_PUBLIC_SITE_URL`, `EXPO_PUBLIC_TURNSTILE_SITE_KEY`, `EXPO_PUBLIC_ENV`; set repo var `DEPLOY_ENABLED=true` to arm `deploy.yml`.
5. **Worker secrets** (both envs): `ADMIN_TOKEN` (random 32 bytes; used by the admin page in M4), `SENTRY_DSN` (optional).

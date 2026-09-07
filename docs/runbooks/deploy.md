# Runbook: deploy

Status: current for M0; secrets/DNS steps below are one-time setup, not per-deploy. Rollback and
manual-deploy sections below were corrected 2026-09-07 (issues #13, #24) after launch audit
finding 18 found them describing a workflow that no longer matched `deploy.yml`.

## Environments

| Environment | Trigger | Worker | Data |
|---|---|---|---|
| preview | every PR, and every push to `main` (`.github/workflows/deploy.yml`) | one shared Worker | its own D1/R2/KV — never production's |
| production | **manual only** — `workflow_dispatch` from the Actions tab, choosing `production` | `keepsake.ing` | production D1/R2/KV |

`deploy.yml`'s trigger logic (`inputs.environment` on `workflow_dispatch`, else always `preview`)
means a push to `main` deploys **preview**, not production — production only ever deploys when a
human runs the workflow by hand and picks it. This page previously said "push to `main`" for
production, which was wrong; so did `docs/design/ops.md:17`, fixed in the same pass. The reason is
in `AGENTS.md`: GitHub's required-reviewer gate is a paid feature on private repos, so "merge to
main ships to the public site" would have had nothing standing in front of it.

Both are gated on the `DEPLOY_ENABLED` repository/environment variable being `"true"`; until the
Cloudflare resources below exist, leave it unset (or `"false"`) so the workflow is a no-op.

## Verifying against preview

**"Preview is one shared Worker" (row above) is not a detail — it is the reason "I checked it on
preview" is not, by itself, evidence of anything (issue #66).** Every open pull request deploys
to the same Worker as every other open pull request and every push to `main`. Deploys queue
(`concurrency: { group: deploy-preview, cancel-in-progress: false }`) rather than run in
parallel, so `deploy.yml`'s own "Verify /health reports this commit" step is never wrong when it
runs — but it proves nothing about a moment later, because the next queued deploy (someone else's
PR) can land seconds after yours finishes. This is not hypothetical: verifying #14, a probe ran 90
seconds after an unrelated branch's deploy landed on top of the one just verified, and got a
commit belonging to neither.

Before trusting anything you observe on preview — a probed endpoint, a page loaded in a browser,
a screenshot — confirm which commit is actually being served, immediately before and immediately
after:

```sh
# One-off check: fails loud (exit 1) if preview isn't on the commit you expect.
node tools/ci/verify-preview-commit.mjs https://preview.keepsake.ing <expected-sha>

# Wrapping a longer verification: checks before AND after <your command>, and fails
# even if <your command> itself "succeeded" — because a redeploy mid-check means
# whatever you just observed may not belong to the commit you thought you tested.
node tools/ci/verify-preview-commit.mjs https://preview.keepsake.ing <expected-sha> -- <your command>
```

`<expected-sha>` accepts a full 40-char commit or any non-empty prefix (short shas from
`git rev-parse --short HEAD` work). Every preview deploy's PR comment (`deploy.yml`'s "Comment
preview URL" step) now includes the exact command to run, filled in with that deploy's real
commit, so you don't have to remember the syntax.

This does not close the race — nothing checked after the fact can, on a Worker other sessions can
redeploy at any time. It converts "silently wrong" into "loudly refuses to proceed," which is the
bar this repo holds every guard to (`AGENTS.md`, "the one rule that matters"). The actual fix —
per-PR preview Workers, or restricting preview deploys to `main` only so preview always means one
knowable thing — needs a decision (and, for per-PR Workers, likely credentials) only Kiarash has;
tracked in the follow-up filed from #66.

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
wrangler secret put RESEND_API_KEY --env preview   # fallback provider only
# repeat with --env production
```

No `SENTRY_DSN` here (issue #14): observability runs on Workers Logs now
(`[observability]` in `apps/api/wrangler.toml`), which is a config flag, not a secret — there is
nothing to provision before it's live. See `docs/design/ops.md#observability`.

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

**Migrations apply (step 3) before the Worker deploys (step 4).** Launch audit finding 18 asked
whether that ordering is right. It is, for the migrations this schema actually has: every one is
additive (`CREATE TABLE`/`CREATE INDEX`/`ALTER TABLE ... ADD COLUMN`, never a `DROP` or a rewrite —
see `apps/api/migrations/`), so the old, still-deployed code has never seen a new column or table
it can't simply ignore. Reversing the order would be worse: new code that expects a column
migrating hasn't created yet would fail on every request, not just the deploy step. The accepted
risk window is narrow and one-directional — if `wrangler deploy` fails or its `/health` check
never matches (step 5), the database is already migrated ahead of the code that's still serving
traffic, and nothing here detects or reverts that automatically. It is a live database against old
code, not old code against a database it doesn't understand, which is why it's survivable: rerun
the workflow once the deploy problem is fixed, and step 3 is then a no-op (already-applied
migrations are skipped) while step 4 catches the Worker up. This was assessed, not just asserted:
no new migration in this repo has ever needed a `DROP`/rewrite, and D1 Time Travel
(`docs/runbooks/restore.md`) covers the 30-day window regardless if a migration ever does.

## Rollback

`wrangler rollback [version-id]` exists (pinned `wrangler` 4.129.0) and is real — this page
previously said it didn't, which was wrong (launch audit finding 18). Verified directly against
the live preview Worker, 2026-09-07:

```sh
cd apps/api
wrangler versions list --env preview          # 10 most recent Versions, newest last
wrangler versions view <version-id> --env preview   # bindings + every var baked into that Version
wrangler rollback <version-id> --env preview -m "why" -y
```

What was actually observed:

- **It is a traffic cutover, not a redeploy.** `curl <preview>/health` reported the target
  version's commit within ~3 seconds of `rollback` returning `SUCCESS`. No `pnpm install`, no web
  export, no migration step — this is why the issue calls it "much faster than a CI re-run."
- **Each Version snapshots its own vars and bindings, not just its code.** `wrangler versions view`
  on two different preview Versions showed different `EMAIL_ALLOWLIST` values and a real (never
  `"dev"`) `COMMIT_SHA` on both, because CI always stamps a real SHA at deploy time. Rolling back
  therefore reverts config too: if a var was deliberately changed since the version you're rolling
  back to, rolling back silently un-changes it as well. Check `versions view` on the target before
  rolling back, not just its age.
- **`wrangler rollback` itself prints the two caveats that matter most**, verbatim from the
  confirmation prompt: "Rolling back to a previous deployment will not rollback any of the bound
  resources (Durable Object, D1, R2, KV, etc)." That is this project's two open traps, in
  Cloudflare's own words:
  - **D1 migrations are forward-only and not part of a Version.** A rollback moves the *code*
    backward; if a migration ran after the target version was originally deployed, the database
    stays on the new schema while the old code runs against it. Old code that only reads
    unmigrated columns tolerates this (see the ordering note above); old code would break if a
    later migration had ever dropped or renamed something it still expects. Check
    `wrangler d1 migrations list <db> --env <env> --remote` before rolling back across a migration
    boundary — it lists exactly what's applied that the target version predates.
  - **Assets are uploaded per deploy and are part of the Version being rolled back to.** Rolling
    back the Worker also rolls back the static web bundle to whatever was exported at that
    version's deploy time. A rollback that leaves new-shaped API responses (post-migration) served
    to an old web bundle expecting the old shape is the same trap as above, from the other
    direction — check what changed in `apps/web` between the two versions, not just `apps/api`.
- **Round-tripped without side effects**: rolled preview back one version
  (`e4f7a11d-…`, commit `561994d3…`), confirmed via `/health`, then rolled forward again to the
  version that was live before the test (`6e3a1929-…`, commit `4f9752d4…`), confirmed via
  `/health` again. No deploy, migration, or data change happened in between.
- **Non-interactive flags**: `-y` accepts the two prompts (which version, confirm), `-m` sets the
  rollback reason shown in `versions list` afterward — both needed for scripting this from CI or a
  runbook rather than a human's terminal.

Use `wrangler versions list` to find the target, then `wrangler rollback <version-id>`. The older
`wrangler deploy --var COMMIT_SHA:<previous-sha>` (a full redeploy of an old ref) still works and
is the only option if you need to roll back *past* what `versions list` shows (10 most recent) or
need to change code, not just cut back to something already uploaded — it goes through the full
pipeline in [What a deploy actually does](#what-a-deploy-actually-does), migrations included.

### Manual deploys and `COMMIT_SHA` (issue #24)

`wrangler.toml`'s `[env.production.vars]` (and `[env.preview.vars]`) both check in
`COMMIT_SHA = "dev"` as a fallback. `deploy.yml` always overrides it with
`--var COMMIT_SHA:${{ github.sha }}`, so it never ships in practice through CI. It exists, plainly,
because a hand-run `wrangler deploy --env production` — the thing you reach for when CI itself is
broken, exactly the moment an accurate commit matters most — will ship `"dev"` if you forget the
flag, and `/health` will report it as fact.

**A manual production (or preview) deploy must pass the real commit:**

```sh
wrangler deploy --env production --var COMMIT_SHA:$(git rev-parse HEAD)
```

This was not made impossible to forget at the `wrangler.toml`/code level — doing that (failing
`/health` or refusing to boot when `COMMIT_SHA === "dev"` in production) means changing
`apps/api/src`, out of scope for this pass (owned by a concurrent agent). Instead,
`.github/workflows/uptime.yml`'s `/health` probe now treats `commit: "dev"` on either tier as a
failure in its own right, distinct from "down" — same mechanism launch audit finding 4 added for
outages, extended to catch this. Verified by extracting the probe's shell and running it three
ways: a real preview response (passes), a stubbed `{"ok":true,"commit":"dev"}` response (fails
with `title=<tier> is running an unstamped deploy`), and a stubbed down response (fails after 3
attempts, unchanged from before) — per `AGENTS.md`'s rule to extract a workflow's shell and run it
rather than trust the YAML by eye.

## Account-side prerequisites

Moved to [kiarash-checklist.md](kiarash-checklist.md) — a step-by-step guide with the exact
dashboard clicks, in the order that unblocks the most verification first.

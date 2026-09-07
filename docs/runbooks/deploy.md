# Runbook: deploy

Status: current for M0; secrets/DNS steps below are one-time setup, not per-deploy. Rollback and
manual-deploy sections below were corrected 2026-09-07 (issues #13, #24) after launch audit
finding 18 found them describing a workflow that no longer matched `deploy.yml`.

**After a production deploy, run [verify-production.md](verify-production.md)** — copy-pasteable
`curl`s for `/health` on the apex (`ok: true`, a real commit SHA, never `"dev"`), `robots.txt` on
both tiers, preview's `/sitemap.xml` 404, and a commit check against what was actually dispatched.
It needs a human on an ordinary network: agent containers cannot reach `keepsake.ing` at all.

## Environments

| Environment | Trigger | Worker | Data |
|---|---|---|---|
| preview | **every push to `main` only** (`.github/workflows/deploy.yml`) — pull requests deploy nowhere | one Worker, always serving `main` | its own D1/R2/KV — never production's |
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

**Preview deploys from `main` only.** Pull requests do not deploy anywhere (decided on #73,
implemented by dropping `pull_request:` from `deploy.yml`'s triggers). So
`preview.keepsake.ing` means exactly one thing: the newest commit on `main` that has finished
deploying.

That was not true before. Preview used to redeploy on every open pull request as well, so the
commit it served at any instant belonged to whichever branch pushed last — which made "I checked
it on preview" evidence of nothing (#66). Deploys queued rather than ran in parallel
(`concurrency: { group: deploy-preview, cancel-in-progress: false }`), so `deploy.yml`'s own
"Verify /health reports this commit" step was never wrong *when it ran* — it just stopped being
true a minute later. Verifying #14, a probe ran 90 seconds after an unrelated branch's deploy
landed on top of the one just verified, and got a commit belonging to neither.

**Verifying a branch now happens locally, not on preview.** `pnpm --filter @keepsake/web e2e`
runs the whole product against real `workerd` with local D1/R2/KV — the same arrangement
production runs, including the `[assets]` binding, `/item/:id`'s HTMLRewriter OG injection, the
SPA fallback and the moderation pipeline (`apps/web/playwright.config.ts` explains why this is
closer to production than `expo start` ever was). CI runs it on every pull request **that touches `apps/web`, `packages/`, `tools/`, `apps/site`
or the root manifests** — `test-web` is gated on those filters and `build-web`/`e2e` hang off it,
so an api-only pull request runs zero e2e specs and `ci-complete` still goes green (#147;
`.github/workflows/ci.yml`, `tools/ci/assert-coverage.mjs`'s `api` row lists no `e2e`). For a
one-off manual poke, `wrangler dev --local` from `apps/api/`.

**Checking preview still matters after a merge**, because "the newest commit on `main`" and "the
commit I just merged" diverge as soon as someone merges again. Before trusting anything you
observe there:

```sh
# One-off check: fails loud (exit 1) if preview isn't on the commit you expect.
node tools/ci/verify-preview-commit.mjs https://preview.keepsake.ing <expected-sha>

# Wrapping a longer verification: checks before AND after <your command>, and fails
# even if <your command> itself "succeeded".
node tools/ci/verify-preview-commit.mjs https://preview.keepsake.ing <expected-sha> -- <your command>
```

`<expected-sha>` accepts a full 40-char commit or any non-empty prefix (short shas from
`git rev-parse --short HEAD` work).

One consequence of the trigger change, and it removes a real hazard: a pull request's migrations
are no longer applied to the shared `keepsake-db-preview` D1 before merge. That sharing is what
let a renumbered migration de-register an already-applied one and break `deploy (preview)` for
every other concurrent pull request (#99).

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
wrangler d1 migrations apply keepsake-db-preview --env preview --remote
wrangler d1 execute keepsake-db-preview --env preview --remote --file ../api/seeds/postal_codes.sql
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

## Vectorize / semantic search (issue #38) — DONE, on in every environment

Semantic search (`SEMANTIC_SEARCH`) is **on** in every deployed environment — preview and production — as of
**2026-09-07**. This section is now the operating and rollback notes, not an
errand. The history is kept because two of its warnings are still live.

### What was actually verified, and how

All three questions this section used to list as unanswerable were answered
with a real credential (a token with `Vectorize` · Account · `Edit`, plus
Workers AI):

| Question | Answer | Evidence |
| --- | --- | --- |
| Do the indexes exist? | **Yes** | Vectorize API lists `keepsake-listings-{dev,preview,production}`, all `dimensions: 768, metric: cosine`. |
| Does the real model work? | **Yes** | `REAL_AI=1` suite run for the first time: 370 passed, 0 skipped. Returns 768-dim, non-degenerate vectors. |
| Does the round trip work? | **Yes** | embed → upsert → query against the real **dev** index returned the correct nearest neighbour (0.7305) ahead of the decoy (0.4695). Probe vectors deleted. |

Re-run the gated block any time with:

```sh
CLOUDFLARE_API_TOKEN=… REAL_AI=1 pnpm --filter @keepsake/api test
```

Without a token that command fails loudly rather than passing on mocks — that
is deliberate (`remoteBindings` in `vitest.config.ts` follows `REAL_AI`).

### `MIN_SCORE`

Re-derived from measurement, not taste: **0.5**. Full run and reasoning in
`docs/design/min-score-calibration.md`; reproduce with
`node tools/calibrate-min-score.mjs`.

The one thing to know before touching it: **the true-match and off-corpus score
distributions overlap** (true matches down to 0.5693, off-corpus junk up to
0.6151), so no cutoff separates them. `MIN_SCORE` is a floor that lets the FTS
fallback fire on an empty or degenerate index — it is *not* a relevance
classifier, and raising it toward 0.62 to "improve precision" trades a graceful
fallback for silently dropped matches. Two tests in `test/search.test.ts` pin it
to the justified band and fail if it moves out either side.

The previous value, 0.3, was below every score this model produces for anything
at all, which made the "nothing cleared the bar" fallback unreachable.

### Listings that predate the feature — do this after the first deploy

`reembedListing` runs on listing **create**, listing **edit**
(`routes/listings.ts`), and each listing the **#37 aspects backfill** touches
(`src/backfill/aspects.ts`). There is no vector-only backfill and no admin
endpoint that drives one directly.

So a listing written while `SEMANTIC_SEARCH` was `"0"` has no vector and is
invisible to vector search until something writes it again.

**This applies to production right now.** The comment this section used to
carry said the flag was flipped while the production catalogue was still empty,
so no backfill would ever be needed. That was not true: #135 measured a real
production listing (the KastKing fishing-line spool,
`01M1XP7SYFDR05M1CPAH0020EE`) against production's own `GET /api/feed` hours
before this merged, and the feature has never been deployed anywhere. Every
listing that exists today therefore predates it.

After the first deploy that carries this, run the aspects backfill — it now
embeds each listing it processes:

```sh
curl -X POST https://<host>/api/admin/backfill-aspects -H "Authorization: Bearer $ADMIN_TOKEN"
```

Note the one listing that needs a nudge first: the spool already has a
`listing_aspects` row (`material: braided`), and the job skips any listing that
already has rows (#139 flagged the same thing for its new prompt), so it will
not be reached until that row is cleared. Everything else with no aspects is
picked up on the first pass.

**If you switch the flag off while listings are being created**, switching it
back on means running that backfill again for the gap — or writing a
vector-only one (model it on `src/backfill/aspects.ts`: batched,
budget-respecting, resumable, idempotent).

### Rolling back

`SEMANTIC_SEARCH = "0"` in the relevant `wrangler.toml` env block and deploy.
That is a complete rollback: the flag is checked before any embedding or
Vectorize call on both the read and write paths, so with it off no AI budget is
spent and `GET /api/feed?q=` is exactly the FTS5 search `main` has always
served. There is a test asserting that equivalence against a no-binding control.

Do **not** roll back by re-commenting the `[[vectorize]]` bindings. The flag is
the kill switch; the binding is not. Note the asymmetry that made this section
so cautious originally: an uncommented binding naming an index that does *not*
exist fails the Worker upload and takes down **every** deploy of this Worker,
including changes unrelated to search. The indexes are confirmed to exist now,
so the bindings are safe — but if anyone ever deletes one, deploys break rather
than search degrading.

Index config cannot be altered after creation. Changing `MODELS.embedding` to a
model of a different width means deleting and recreating all three indexes, and
re-embedding everything in them.

### Privacy

`apps/site/public/privacy.html`'s "Search by meaning" section says the feature
**is running**, that the vectors are stored with Cloudflare beside the listing
id, and that deleting a listing deletes them.
`apps/web/test/guards/privacyPolicy.test.ts` (#88) asserts those sentences and
fails the build if they disappear. If the feature is ever switched off for good,
the policy and that guard have to change together.

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

## The per-PR preview token (#73) — provisioned, then not used

**Read the decision history before reaching for this.** #73 was decided twice on 2026-09-07: first
for per-PR preview Workers (option 1), which is why this token exists and was verified; then
**reversed to main-only preview deploys, per-PR Workers declined**, which is what shipped in #107
and is what `deploy.yml` does today. The token below is therefore *stranded capability* — real,
verified, rolled, sitting in a GitHub environment secret, and used by nothing. Nothing uses it and
nothing is waiting on it.

Kept rather than revoked because the reversal was a cost call (the CI work to provision and tear
down, not the resources), not a discovery that the approach doesn't work — so if per-PR previews
are ever revisited, this section is the measurement that need not be repeated. See
[`docs/product-decisions.md`](../product-decisions.md). If the answer stays no, the honest cleanup
is to revoke `keepsake-pr-preview` and delete the secret rather than leave a create-and-delete
credential live for a feature nobody is building.

`deploy.yml` does not use this. It is a **second, separate** token from
`keepsake-ci-deploy` (which stays exactly as narrow as it was, and is what
`CLOUDFLARE_API_TOKEN` still holds): a per-PR job has to *create and delete* resources, not just
write to two known ones, so its blast radius is genuinely larger and it is kept in its own
credential rather than widening the everyday deploy token.

- Cloudflare token **`keepsake-pr-preview`** (id `7f49516e…`), account-scoped to the Leapkg
  account only, permission groups: D1 Write + Read + Metadata Read, Workers R2 Storage Write +
  Read + Metadata Read, Workers KV Storage Write + Read + Metadata Read, Workers Scripts Write +
  Read, Account Settings Read.
- Stored as the GitHub **preview** environment secret **`CLOUDFLARE_PR_PREVIEW_TOKEN`** (rolled
  and re-stored 2026-09-07, so the secret and the token are known to match — the value predating
  that was never verified against the token's real scopes).

Every capability below was exercised against the live account with that token on 2026-09-07, then
cleaned up; none of it is inferred from the permission-group names:

| Operation | Result |
|---|---|
| `POST/GET/DELETE /d1/database`, `POST /d1/database/:id/query` | works (created, queried, deleted `keepsake-db-pr-probe`) |
| `POST/GET/DELETE /r2/buckets` | works (created and deleted `keepsake-photos-pr-probe`) |
| `POST/DELETE /storage/kv/namespaces` | works |
| `PUT/DELETE /workers/scripts/:name` + `POST .../subdomain` | works — `keepsake-pr-probe.leapkg.workers.dev` served a live response, then deleted |
| mint another API token / read or write DNS | **refused** (9109 / 10000), as intended |

Two things that were open questions when #73 was filed, now answered by measurement rather than
assumption:

- **"D1 Write" already implies read.** Cloudflare's `Write` groups are supersets of their `Read`
  counterpart, and `keepsake-ci-deploy` — which holds D1 Write and *no* D1 Read — has been running
  `wrangler d1 migrations apply --remote` (a read of `d1_migrations`) successfully all along. The
  Read/Metadata Read groups above were added anyway: they cost nothing, and a token whose grants
  are explicit is one nobody has to re-derive this from CI logs again.
- **The account is on Workers Paid, not Free.** Probed directly: 12 D1 databases were created in
  sequence with no refusal, well past the Free plan's ceiling of 10 (paid allows 50,000). One D1
  database, one R2 bucket, one KV namespace and one Worker per open PR is nowhere near a plan
  limit; the real cost of per-PR previews is the CI work to provision and tear them down, not the
  resources themselves.

**Still not solved by this token, and moot while per-PR previews stay declined: Turnstile.** Widget hostnames are not in its scope (it can read
widgets, not write them), so a `keepsake-pr-<n>.leapkg.workers.dev` origin is not an allowed
hostname on the `Keepsake` widget and every write path there would fail `turnstile_failed`. That
is a one-time dashboard action rather than a per-PR one, because Turnstile hostnames cover
subdomains: adding `leapkg.workers.dev` to the widget covers every future PR Worker at once
(wildcards are rejected; the free tier allows 10 hostnames per widget). The trade-off to make
knowingly is that `leapkg.workers.dev` is a *shared* subdomain — every other Worker on this
account gets to use the Keepsake site key too. The alternative is accepting that PR previews run
with Turnstile unenforced, which makes them unusable for verifying exactly the write paths most
worth verifying.

## The cache-purge token (#94)

`purgePhotoCache` (`apps/api/src/lib/photoCache.ts`) has two reaches, and the distinction is the
whole of #94: `caches.default.delete()` clears **only the colo executing that request**, while
`POST /zones/:id/purge_cache` clears **every colo**. The zone call needs a zone (`keepsake.ing`)
and a token scoped to its cache-purge permission. This is that token; #117 is the code that calls
it.

- Cloudflare token **`keepsake-cache-purge`** (id `1dc0212c…`), one policy: `Zone → Cache Purge`,
  resource **`keepsake.ing` only** (zone `dcc1fb09eeeba27a343fc1d98aff9094`). Zone-scoped, not
  account-scoped — unlike `keepsake-pr-preview` above it cannot see any other zone on this account.
- Stored as the Worker secret **`CF_CACHE_PURGE_TOKEN`** on `keepsake-preview` and
  `keepsake-production` (2026-09-07), not as a GitHub Environment secret: the purge runs inside the
  Worker at request time, not in CI.
- `CF_ZONE_ID` is a `[vars]` entry, not a secret — a zone id is not sensitive. Already set for
  preview and production; deliberately `""` in the dev block, where the zone call is a silent
  no-op.

Both halves must be present or `purgeZoneCache` returns without calling anything, silently and by
design. That is the right default for local dev and e2e, and it is also the failure mode to keep in
mind here: **a missing or empty secret looks exactly like normal operation.** Nothing logs, nothing
throws, and the per-colo delete still happens, so an unconfigured environment is indistinguishable
from a working one by observation alone.

Scope was proven with negative controls, not `GET /user/tokens/verify` — which only reports that a
token is active and never what it can do:

| Operation | Result |
|---|---|
| `POST /zones/dcc1fb09…/purge_cache` (keepsake.ing) | works |
| same call against another zone on this account (`tts.gallery`) | **refused** (10000) |
| `GET /zones/dcc1fb09…/dns_records` | **refused** (10000) |

### What zone purge does and does not reach — measured 2026-09-07

A `"success": true` from `purge_cache` is **not** evidence a purge happened. Both results below
come from the same token and the same request body against the same zone:

- **Worker `caches.default` entries: purged globally.** Warmed
  `https://preview.keepsake.ing/i/<id>/full` to `CF-Cache-Status: HIT` at two colos (MXP and FRA,
  distinct `cf-ray` suffixes and independently-advancing `age` values — 152–162 s and 118–127 s —
  so genuinely two entries, not one seen twice). One purge-by-URL call from one place; the first
  observation at *each* colo afterwards was a fresh response (no `CF-Cache-Status`, no `age`),
  exactly one per colo, then re-warm. Propagation was under 4 seconds. This is the behavior #94
  needs, and it is the part that was previously only assumed.
- **Workers Assets responses: not purged at all.** The same call against
  `/_expo/static/js/web/entry-<hash>.js` returned `"success": true` and changed nothing — 30/30
  `HIT` over 90 s at both colos, URL otherwise untouched. Static assets are served by the Assets
  system, whose cache `purge_cache` does not own. **Do not smoke-test this token against an asset
  URL**; a working credential will read as a broken one.

Assert on cache identity (`CF-Cache-Status` disappearing, `age` resetting), never on a 404.
`GET /i/:id/:variant` re-reads the listing from D1 and 404s *before* it consults the cache, so
"delete the photo, then fetch it from another colo and expect 404" passes whether or not anything
was purged — it has no negative control. That is a separate false pass from the one the one-hour
`max-age` causes, and the easier of the two to miss.

### The one link still unverified

Everything above tests the token directly with `curl`. What has *not* been observed is the
deployed Worker making that call with the value stored in its own secret — i.e. that
`CF_CACHE_PURGE_TOKEN` on `keepsake-preview`/`keepsake-production` holds the real token rather than
something truncated or whitespace-damaged. Wrangler cannot read a secret back, and per the silent
no-op above, a damaged value would not announce itself.

Two things make it low-risk rather than unknown: the value was piped with `printf '%s'` from a
53-byte file whose last byte is a token character, and `purgeZoneCache` `.trim()`s both the token
and the zone id, so trailing whitespace could not break it even if present.

To close it properly you need a real `DELETE /api/listings/:id`, which needs an owner token, which
means creating a disposable listing on preview. Once one runs, check that the token's usage
advanced:

```sh
curl -s https://api.cloudflare.com/client/v4/user/tokens/1dc0212c68755d23991b4fe2f43973d4 \
  -H "Authorization: Bearer $CF_API_TOKEN" | jq .result.last_used_on
```

As of 2026-09-07 09:20Z that reads `2026-09-07T08:53:02Z` — the manual `curl` tests above, not the
Worker. Note the field lags: purges at 09:00, 09:03 and 09:06 had not moved it by 09:20, so treat
it as "has this token ever been used since X", not as a live counter. A failed purge is the easier
signal — `photoCache.ts` reports one through Workers Logs as
`Cloudflare zone cache purge failed for photo <id>`, with Cloudflare's own `errors[]` in `extra`.

## What a deploy actually does

1. `pnpm install --frozen-lockfile`
2. `pnpm --filter @keepsake/web export` with every `EXPO_PUBLIC_*` value `.env.example` declares
   baked in. The export step used to pass four of the seven (`SITE_URL`,
   `TURNSTILE_SITE_KEY`, `CF_WEB_ANALYTICS_TOKEN`, `ENV`) while `config.ts` read all seven, so
   `EXPO_PUBLIC_GOOGLE_ADS_ID`, `_GIVE_LABEL` and `_REQUEST_LABEL` baked as `""` in every
   deployed bundle with nothing failing — the guard meant to catch that built its expectations
   from `process.env`, i.e. from the very environment that was missing them. Both halves are
   fixed: `deploy.yml` now names all seven, `verify-public-env.mjs` derives its expected set from
   `.env.example` and fails a deployed export when a declared name is unset, and preflight's
   `public-env-passthrough` compares the two lists on every pull request.
   **This step fails today**, deliberately: the three Google Ads variables are listed in the
   workflow but are not set in either GitHub Environment, so no ads tag has ever loaded. Setting
   them (or removing the three names from `.env.example` and `config.ts`) is the open decision —
   leaving them declared, read, described in `docs/legal-considerations.md`, and passed by
   nothing is the state that produced #175.
3. `wrangler d1 migrations apply keepsake-db-<env> --env <env> --remote` — the database is named
   per tier (`keepsake-db-preview` / `keepsake-db-production`); plain `keepsake-db` is the
   top-level dev name only and matches neither deploy env
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

**Update:** this is now also enforced at the code level, not just documented and monitored.
`apps/api/src/index.ts`'s very first middleware refuses every request — not just `/health` — with
a `503` and an explicit message when `ENVIRONMENT === "production"` and `COMMIT_SHA` is still
`"dev"`. That is deliberately the entire site, not only `/health`: the point is that a forgotten
flag is caught the instant anything hits production, by whoever just ran the manual deploy, rather
than only in a rolled-up health check nobody happens to be looking at. `preview` and local
`wrangler dev` are unaffected — `isProduction()` (`apps/api/src/env.ts`) is `false` for both, and
`"dev"` remains the correct, expected value there.

This is a guard, not a substitute for the flag above — fix the deploy (redeploy with
`--var COMMIT_SHA:$(git rev-parse HEAD)`), don't work around the guard.

`.github/workflows/uptime.yml`'s `/health` probe *also* independently treats `commit: "dev"` on
either tier as a failure in its own right, distinct from "down" — same mechanism launch audit
finding 4 added for outages, extended to catch this. This is deliberate belt-and-braces, not
redundant: the Worker-level guard above fires the instant a request arrives but only if a request
arrives, while the CI probe fires on its own schedule (~15-20 min) even if nothing else hits
production in the interim. Verified by extracting the probe's shell and running it three ways: a
real preview response (passes), a stubbed `{"ok":true,"commit":"dev"}` response (fails with
`title=<tier> is running an unstamped deploy`), and a stubbed down response (fails after 3
attempts, unchanged from before) — per `AGENTS.md`'s rule to extract a workflow's shell and run it
rather than trust the YAML by eye.

## Account-side prerequisites

Moved to [kiarash-checklist.md](kiarash-checklist.md) — a step-by-step guide with the exact
dashboard clicks, in the order that unblocks the most verification first.

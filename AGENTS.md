# Working on Keepsake

Read this first. It is the shortest path from cold start to useful work, and it records the
mistakes this project has already made so you do not repeat them.

## What Keepsake is

A free gifting marketplace at `keepsake.ing`. Someone photographs a sentimental object, writes its
story, and posts it. Anyone nearby can browse. A stranger leaves a note and an email; the giver
picks one and they meet in person to hand it over. **No money. No accounts** — a giver is a
device-bound secret token plus an optional verified email.

The product is the story. Anything that makes a listing feel like a classified ad is wrong.

## Where things stand

- **Preview**: <https://preview.keepsake.ing> — the whole product, live from `main`. It deploys
  on every push to `main` and **nowhere else**: pull requests do not deploy
  (`.github/workflows/deploy.yml`). So preview means exactly one knowable thing, the newest
  commit on `main`. This is the resolution of #66/#73 — preview used to redeploy on every open
  pull request too, which made the commit it served at any instant belong to whichever branch
  pushed last. **Verify a branch locally instead** (`pnpm --filter @keepsake/web e2e`, real
  `workerd` + local D1/R2/KV); see "Verifying against preview" below for what preview is still
  good for and what still needs a commit check.
- **Production**: <https://keepsake.ing> — live. The custom domain is attached to
  `keepsake-production` and both of that Worker's `workers.dev` hostnames are disabled, so the
  apex is the only way in (#46, 2026-09-07). Production deploys stay **manual**
  (`workflow_dispatch` from the Actions tab, choosing `production`) because GitHub's
  required-reviewer gate is a paid feature on private repos — merging to `main` does **not** ship
  the public site, so **production runs behind `main` routinely**. Never assume a merged fix is on
  the live site: `uptime.yml` prints the commit each tier serves every 15 minutes, and reading that
  log is the only observation of production an agent container can make. At 2026-09-07 15:46 UTC it
  was five commits back.
  Email is `live` there for all recipients (#43). #6, which carried "delivery to any address other
  than Kiarash's has never been observed arriving", was **closed on 2026-09-07 with no closing
  comment and no written result** — read `docs/design/README.md` before repeating either the old
  claim or a proof nobody recorded.
  The preview Worker's `workers.dev` hostnames, unlike production's, are still enabled (#105).
- **Ask the Observatory before guessing** (#150). `GET /api/admin/observatory` — or `/admin` →
  Observatory — answers "is anything stuck" in one call: the give→get funnel, how long the
  moderation queue has been waiting (an *age*, not just a depth), the per-day series, edge traffic
  and error counts from Cloudflare, the Worker's own recent error lines, and today's digest. Its
  D1-derived half needs no credential and works locally; the two Cloudflare panels need
  `CF_OBSERVATORY_TOKEN` and say so plainly when it is missing. A daily digest of the same numbers
  mails at 00:07 UTC, every day including quiet ones. `docs/runbooks/admin.md` has the detail.
- **The UK is geo-blocked on purpose** (`docs/runbooks/uk-block.md`). Not a bug.
- Work is tracked as GitHub issues across five milestones. Conventions in
  `docs/runbooks/issue-workflow.md`.

## Picking up work

**More than one session works this repo at once.** Kiarash runs sessions from his phone and from
claude.ai alongside whatever is running locally. The label is the only shared source of truth
about who has what.

1. `gh issue list --label "launch-blocker" --state open` — or browse a milestone.
2. **Read the labels immediately before you start, not from memory.** This has already gone wrong
   once: a coordinator handed an agent five issues based on what it remembered labelling, and
   four had been claimed by another session minutes earlier. Re-read
   `gh issue list --label "status: in progress"` at the moment you assign or begin work, however
   recently you looked.
3. **Skip anything labelled `status: in progress`.** That label is the lock; another session or a
   human is in those files right now.
3. Add `status: in progress`, comment saying what you intend to change, then work.
4. Reference the issue in commits (`Closes #12`, or `Refs #12` for partial work).
5. On finish, comment with **what changed and how you proved it**, then remove the label.

**Branch from `main` and merge before you stop.** Short-lived branches, one pull request per
coherent chunk. A sixteen-commit branch already cost another session a duplicated fix and eight
conflicted files, and hid a live bug on `main` until the two finally met. The full test suite only
runs on a pull request, so an unmerged branch is also an untested one.
`docs/runbooks/issue-workflow.md` has the detail.

## Admin tokens

`/api/admin/*` takes `Authorization: Bearer <token>`. **The tokens are written down here**, on
purpose: this is a private repo, and a session that has to ask a human for a credential before it
can look at the Observatory is a session that will guess instead.

| Tier | Base URL | Token |
| --- | --- | --- |
| preview | `https://preview.keepsake.ing` | `1ZY1sOARvge6cX-0y5c_eOEEAA8-AMMfl-Ob4kHwMIA` |
| production | `https://keepsake.ing` | `ydPctMVuNm9-FR4TEZmZzuS1HsW64o1REcPVn_f1VcQ` |

```sh
curl -s https://preview.keepsake.ing/api/admin/observatory \
  -H "Authorization: Bearer 1ZY1sOARvge6cX-0y5c_eOEEAA8-AMMfl-Ob4kHwMIA" | jq
```

**Use preview unless you specifically mean the live site.** The tiers do not share a token, and a
mismatched one is an ordinary `401` — indistinguishable from a typo, because `/api/admin/*`
answers `401` identically for wrong, missing and never-configured. That is deliberate (the
response must not reveal whether admin is set up), so a failed call tells you nothing about which
of the three it was.

**What these grant.** There are no scopes. The same string that reads the Observatory can hide
listings, approve and reject them, ban owners, remove requests, and read a requester's note, email
address and phone number. Treat the production one as reaching real people's contact details,
because it does.

Consequences of them living here, so nobody is surprised later:

- **Rotation is a commit, not just `wrangler secret put ADMIN_TOKEN --env <tier>`.** Both halves
  have to move together, and the old value stays in git history regardless — rotation makes the
  committed value useless, it does not remove it.
- These values are in every clone, every CI checkout and every agent's context. Do not paste them
  into anything outside this project, and do not echo them into a log, an issue comment or a PR
  body.
- If this repository is ever made public, or gains a collaborator who should not have admin,
  **rotate both tokens first** — treating the history rewrite as optional is the mistake.

Every other credential is still a real secret and is *not* here: `ADMIN_TOKEN` remains a Worker
secret set with `wrangler secret put`, and the Cloudflare tokens live in Worker secrets or GitHub
environment secrets, which no session can read back (the GitHub secrets API returns only `name`,
`created_at` and `updated_at` — there is no value field).

## The one rule that matters

**A passing test is not evidence. Verify the artifact.**

This project has shipped eleven separate checks that could not fail:

| What looked fine | What was actually true |
|---|---|
| Image moderation, tests green | The prompt showed the model a filled-in example, so it copied the safe answer instead of looking. Every score was decorative. |
| Bot-check site key configured | The bundler cached the inlined value; every build shipped an empty key, so the widget would never have rendered. |
| Accessibility suite green | Three real contrast bugs were inside named exclusions and could never fail it. |
| End-to-end suite green | The job was gated behind a job that only ran on API changes, so it had never once executed. |
| A rate limiter declared in every environment | It was called from nowhere. 320 parallel requests, 320 successes. |
| `tools/preflight/preflight.test.mjs` — 55 tests whose whole job is proving each preflight check can still fail | Nothing ever ran them. `tools/*` are workspace packages, but `pnpm test`'s runner only invoked the preflight *binary* and CI's `test-packages` filtered on `./packages/*`. The tests that guard the guards had never executed once. Found while adding the 56th (#99). |
| Three commits merged to `main`, nothing red in the Actions tab | Not a check that could not fail — a check that silently *did not run*. CI's concurrency group was one bucket for `main`, so each merge cancelled the previous merge's run; `cancelled` is neither red nor green, nothing reads it, and `deploy.yml` shipped each of those commits to preview anyway. The merged *combination* — the one thing a PR run never tests — went out untested three times (#103). |
| `SKIP shell-syntax  no *.sh files under tools/ or .github/` | There has never been a `.sh` file in this repository, in the tree or in history, so the check had skipped **every time it ever ran** — while all the shell that matters sits inline in workflow `run:` blocks, including the `uptime.yml` probe that is the only monitor of the live site. A new variant worth naming: its *test* was sound and passed, but only ever against a fixture tree containing an invented `.sh` file — **a test that can only fail against inputs the repo does not contain.** Fixed by parsing `run:` blocks and making "found no shell at all" a failure (#166). |
| `PASS cron-triggers  3 cron(s) valid` | It read `wrangler.toml` and `index.ts`. `cron/registry.ts` — the file `/api/admin/health` and the daily digest actually read, and which two documents said this check tied to the other two — was never opened. Renaming a job and moving its schedule in the registry alone still reported three valid crons, naming the *old* schedules (#176). |
| A documented, executed, verified D1 backup | The `--table` list was hard-coded and went stale when `0006_aspects.sql` landed, so no export contained any listing's aspects — and because `listings.aspects_backfilled_at` *is* in the export, every restored listing said "already done" and its aspects could never be re-derived. The restore closed its own recovery path. The runbook glob-loops the *migrations* to avoid exactly this, one paragraph away (#164). |
| `[verify-public-env] 4 value(s) present in the bundle` | It built its expectation set by filtering `process.env`, so a variable `deploy.yml` forgot to pass was absent from the expectations too and could never be reported missing. It could only verify what had already been passed correctly — structurally blind to the shape of the bot-check incident two rows above. Three Google Ads ids shipped as `""` in every deployed bundle, and a legal document asserted the tag was live (#175). |

So: when you add a guard, **break the code and watch the guard fail**, then restore. Say in the
issue comment which one you broke. This applies to observability too, and is why
`GET /api/admin/observatory`'s Cloudflare panels return `ok` / `error` / `unconfigured` rather than
a nullable payload: a dashboard that cannot tell "I did not look" from "I looked and saw nothing"
is another check that cannot fail, and an empty chart is the most convincing wrong answer there
is. If you find yourself guessing why a panel is empty, that is a bug — file it. When you fix something user-visible, look at it — curl the
deployed URL, read the actual bytes, take a viewport screenshot. Do not screenshot with
`captureBeyondViewport`; that is how a page nobody could scroll looked perfect for a week.

**And one more, #66: "verified on preview" was never safe to say.** `deploy.yml`'s own
"Verify /health reports this commit" step is not one of the eleven above — it's correct at the
moment it runs. What was worthless was trusting it a minute later, because preview was one shared
Worker that every open PR deployed to, so another session's deploy could land between CI's check
and whatever you did next. This happened for real verifying #14 — a probe ran 90 seconds after an
unrelated branch redeployed over it, and would have silently "confirmed" the wrong commit if the
endpoint under test hadn't 404'd instead.

**That trigger is now gone** (#73): preview deploys from `main` only. Verify your branch locally
with `pnpm --filter @keepsake/web e2e`, which runs the real Worker against local D1/R2/KV. Preview
is still worth checking *after* a merge, and there the commit check still applies, because "newest
commit on `main`" stops being your commit as soon as someone else merges:

```sh
node tools/ci/verify-preview-commit.mjs https://preview.keepsake.ing <expected-sha>
# or wrap the whole verification so drift mid-check fails loud instead of silently passing:
node tools/ci/verify-preview-commit.mjs https://preview.keepsake.ing <expected-sha> -- <your command>
```

See `docs/runbooks/deploy.md#verifying-against-preview`.

## Environment gotchas that will cost you an hour

- **Never start a filesystem search at `/`.** Agents here have burned 40 minutes on `find /` three
  times for files sitting in `node_modules`. Scope to the repo.
- **Deploy from a clean checkout**, not the working tree — there is usually a concurrent agent
  editing it. `git -C /tmp/ks-deploy checkout --detach origin/main`, then `cp -Rc` the
  `node_modules` in (APFS clone, seconds). **Symlinking node_modules breaks esbuild's resolution
  of `@keepsake/*`** — it will fail with "Could not resolve".
- **`expo export` needs `--clear`.** Public config is inlined at transform time and cached; the
  export script does this and then verifies the values actually reached the bundle.
- **Turnstile enforces on preview, but not on every write path.** In `src/routes/listings.ts`
  `turnstile()` is mounted on exactly three routes — `POST /api/listings`,
  `POST /api/listings/:id/reports` and `POST /api/listings/:id/requests` — plus one in
  `src/routes/me.ts` and one in `src/routes/recover.ts`. Those you cannot drive with curl, so use
  the admin endpoints, `MOCK_AI`, or a real browser. **Everything else is curl-reachable with an
  owner token**: `PATCH`/`DELETE /api/listings/:id` and `given`/`withdraw`/`relist` mount no
  Turnstile (this bullet listed "create/edit/relist" until 2026-09-07 and was wrong about two of
  the three), and the photo routes mount none of it either — `PUT /api/photos`,
  `DELETE /api/photos/:id` and `POST /api/photos/:id/suggest` carry `ownerAuth()` and the rate
  limiters only (#183, open). `PATCH` stays without it deliberately (#168): the web edit step
  mints no token, so adding one would break the real edit flow rather than harden it — what it
  got instead is the router-level burst brake and a daily budget. Do not rely on Turnstile as the
  reason a write path is unreachable without checking that the route actually mounts it.
- **Every non-GET route on `listingRoutes` is metered by a router-level registration**
  (`listingRoutes.on(["POST","PATCH","PUT","DELETE"], "*", burst("RL_WRITE"))`, PR #197 / #168),
  the same shape as `adminRoutes.use("*", …)`. Add a write route to that file and it is metered
  by default; `test/listingWriteMetering.test.ts` enumerates `listingRoutes.routes` and fails if
  one appears outside the list it exercises. The equivalent writes in `src/routes/photos.ts` and
  `src/routes/me.ts` still carry per-route decisions and `POST /api/me/listings/:id/choose` and
  `DELETE /api/photos/:id` remain unmetered — #168 names them.
- **Email**: preview is `allowlist` (Kiarash and `leapkg@gmail.com` only), production is `live`.
  Reserved domains (`example.com`, `.test`, `.invalid`) are refused everywhere, which is why the
  repo's fixtures cannot bounce the sending domain. `EMAIL_MODE=test` bypasses the guard and a
  config test fails the build if it ever appears in `wrangler.toml`.
- **Name a new migration `YYYYMMDDHHMMSS_slug.sql`** (UTC — `date -u +%Y%m%d%H%M%S`), never
  `0009_slug.sql`. D1's `d1_migrations` ledger is keyed on the **filename**, and a sequential
  number is a shared namespace: two sessions cut from the same `main` both claim `0009`, the one
  that merges second must renumber on rebase, and renaming a file the shared preview has already
  applied makes the next deploy re-run its SQL. That broke `deploy (preview)` for every
  concurrent pull request once already (#99). The existing `0001`–`0009` stay exactly as they
  are — renaming them would *be* the bug. `node tools/preflight/preflight.mjs --only
  migrations,migration-drift` enforces both halves; `docs/runbooks/migrations.md` has the detail.
- **Never edit, rename or delete a migration that has landed on `main`, or that this branch has
  already pushed.** Add a new migration instead. There is no exception; a deploy cannot undo one.
- **The e2e suite runs entirely locally — use it, it is the best verification available.**
  `pnpm --filter @keepsake/web export` then `pnpm --filter @keepsake/web e2e` stands up real
  `workerd` with local D1/R2/KV via `wrangler dev` (see `apps/web/playwright.config.ts`), which is
  closer to production than preview ever was and needs no credentials. Baseline was 84 passing;
  #173 added six a11y specs, which is twelve more runs across the two projects.
  Now that pull requests no longer deploy anywhere, this is *the* way to verify a branch.
  - If Playwright reports `Executable doesn't exist at .../chromium_headless_shell-<n>/...`, the
    container's browser build predates the pinned `@playwright/test`. Do not run
    `playwright install` blindly; point the expected path at the build that is present. Concretely,
    with `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` holding a `-1194` build and Playwright asking
    for `-1243`, symlinking the present build under the expected name and filling in the two
    marker files (`INSTALLATION_COMPLETE`, `DEPENDENCIES_VALIDATED`) is enough — note the
    directory *and binary* also get renamed between builds
    (`chrome-linux/headless_shell` → `chrome-headless-shell-linux64/chrome-headless-shell`), so
    linking the folder alone still fails. All 84 specs pass on the older build (Chromium
    141.0.7390.37); nothing about the suite needs the newer one. Re-confirmed 2026-09-07 with a
    `-1194` build linked under the expected `-1243` name.
  - **`e2e/versionSkew.spec.ts` fails if `dist/` is older than `HEAD`, and says nothing about
    why.** It reads `dist/version.json` and compares against the commit hash baked into the
    bundle, so exporting at one commit and then moving `HEAD` (a merge, a rebase, a new commit)
    before running makes two specs fail with `expect(locator).not.toBeVisible()` and the banner
    text "A new version of Keepsake is ready." — which reads like a real version-skew regression
    and is not one. That is the guard working: the bundle genuinely was built against a different
    commit. **Re-export before believing it** (`pnpm --filter @keepsake/web export`), then re-run;
    it cost one diagnosis cycle on 2026-09-07 doing exactly this, merging `main` in between the
    export and the run.
  - `test/adminAuth.test.ts`'s brute-force case can time out at 30 s when the root runner fans API
    and web out concurrently on a loaded machine. Measured on both `main` and a feature branch with
    no difference, so it is load, not a regression — the flake its own comment and #65 describe.
    Re-run it alone before believing it. **#65 is closed and the flake is back**: #116 (open) says
    it either regressed or was never fixed at the cause, so treat "#65 explains it" as the old
    answer, not the current one.
- **The admin tokens are in this file** (see "Admin tokens" below), so no session — local, phone
  or claude.ai — needs to source anything to call `/api/admin/*`. Every other credential still
  lives outside the repo: Cloudflare tokens are Worker secrets or GitHub environment secrets, and
  a session cannot read those.
- **A sandboxed agent may not be able to reach the product at all.** Some environments' egress
  policy answers `403` to `CONNECT` for `keepsake.ing`, `preview.keepsake.ing` and
  `workers.cloudflare.com`, and blocks GitHub's Actions-configuration API paths. That is a policy
  denial, not a broken tool: do not retry it and do not route around it. Say plainly that you could
  not observe the thing, and use CI's own logs as evidence instead — `uptime.yml` prints the commit
  each tier is serving every 15 minutes, which is a real observation of the live site that you can
  read without reaching it.
- **`wrangler d1 export` refuses any database with FTS5 tables** — ours has one. Migrations own
  the schema; exports only carry rows. See `docs/runbooks/restore.md`.
- **A lone `7403` from the D1 API is transient.** Retry once before believing it.
- **A new cron is three edits, and one of them changes an unrelated test.** Name, schedule and
  staleness threshold live together in `apps/api/src/cron/registry.ts`; `wrangler.toml`'s
  `[triggers] crons` has to restate the schedule because Cloudflare reads that file, and
  `index.ts`'s `scheduled()` switch has to match the literal string. Preflight's `cron-triggers`
  check now enforces all three: every registry `cron` must be a trigger that resolves for every
  env block, every registry `name` must be the literal string `scheduled()` hands `runCron`
  (that argument *is* the heartbeat key `cron:last:<name>`), and `staleAfterMs` must exceed the
  schedule's own interval. It used to read only the `wrangler.toml` ↔ `scheduled()` pair while
  two documents claimed otherwise, so a job renamed or rescheduled in `CRON_JOBS` alone passed it
  clean (#176). It compares *declarations*: a job correctly declared everywhere that still never
  writes its heartbeat at runtime is a different bug, and not one this check can see. The part
  that surprises people: `GET /api/admin/health` derives `ok` from
  **every** job in the registry, so adding one turns `ok: true` into `ok: false` in any test that
  seeds only the heartbeats it knew about. That is the guard working — a job nothing watches is
  the bug — but budget for updating those tests.
- **A cron expression inside a `/** */` block comment ends the comment.** `*/5` closes it, and the
  parse errors that follow point at the code below, not at the comment. Write the schedule in
  prose or use `//`.
- If a var changes, update **all three** `wrangler.toml` env blocks and `.env.example`, or
  preflight's parity check fails.

## Before you say you are done

```
pnpm lint                          # 0 errors; warnings are the zod const+type idiom
pnpm -r typecheck
pnpm test                          # preflight, packages, api, web
pnpm --filter @keepsake/web e2e    # 84 specs, mobile and desktop
node tools/preflight/preflight.mjs
```

The accessibility specs carry **no per-rule or per-selector exclusions**. One thing still narrows
what they can catch, so "green" is not quite "everything was scanned": `a11y.spec.ts` fails only
on `serious` and `critical` impacts, so `moderate`/`minor` violations are reported by the run and
never fail it. Within that scope: if your change fails them, it is your change.

Two gaps that were in this paragraph until #173 are now covered, and the way they were covered is
worth copying. The shared fixture (`e2e/support/fixtures.ts`) seeds a consent decision into every
context, so the consent banner was never in the DOM during a scan — the first interactive element
a new visitor meets was the one component the suite structurally could not see, while two comments
in the tree said otherwise. `a11y.spec.ts`'s "consent banner" block now builds its own **unseeded**
contexts (it asks Playwright only for `browser`, so the seeding fixture never runs) and scans the
banner closed and with its preferences panel open. And no scan had ever run in dark mode, though
`[data-theme="dark"]` is an entire second colour system; the "dark mode" block now re-runs the page
scans under `colorScheme: "dark"` and asserts `data-theme` really is `dark` before scanning, so it
cannot pass by having scanned the light palette twice.

## Where the thinking is written down

- `docs/design/README.md` — status of record and milestone table.
- `docs/design/design-system.md` — the v3 "Polaroids on a table" identity. Two earlier rounds were
  rejected as generic; do not drift back to cream-and-serif cards.
- `docs/design/moderation.md` — how moderation works and two measured model weaknesses.
- `docs/runbooks/launch-audit.md` — 18 findings, several still open.
- `docs/legal-considerations.md` — compliance research, with eight questions marked for a lawyer.
- `docs/legal-entity-and-insurance.md` — why Keepsake is a sole proprietorship and not an LLC
  (#108), what has to be bought and filed because of that, and what would reverse it.
- `docs/product-decisions.md` — the register of product decisions this build rests on, each with
  what it costs and what would change the answer. Read it before reopening one, and add a row when
  you make one.
- `docs/runbooks/` — deploy, restore, migrations, admin (incl. the Observatory and the daily
  digest), incident, geodata, uk-block, uk-reentry-checklist, issue-workflow, launch-audit,
  kiarash-checklist, verify-production.

## Writing for Kiarash

He reads the closing comment, not the diff. Say what changed, how you proved it, and what you did
not do. If a test passed but you did not verify the real thing, say that. He has repeatedly caught
problems by looking at the actual product on his phone; the fastest way to lose his trust is to
not follow his set direction quickly.

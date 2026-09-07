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
  the public site. Email is `live` there for all recipients (#43), and note what that still
  rests on: delivery to any address other than Kiarash's has never been observed arriving (#6).
  The preview Worker's `workers.dev` hostnames, unlike production's, are still enabled (#105).
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

## The one rule that matters

**A passing test is not evidence. Verify the artifact.**

This project has shipped seven separate checks that could not fail:

| What looked fine | What was actually true |
|---|---|
| Image moderation, tests green | The prompt showed the model a filled-in example, so it copied the safe answer instead of looking. Every score was decorative. |
| Bot-check site key configured | The bundler cached the inlined value; every build shipped an empty key, so the widget would never have rendered. |
| Accessibility suite green | Three real contrast bugs were inside named exclusions and could never fail it. |
| End-to-end suite green | The job was gated behind a job that only ran on API changes, so it had never once executed. |
| A rate limiter declared in every environment | It was called from nowhere. 320 parallel requests, 320 successes. |
| `tools/preflight/preflight.test.mjs` — 55 tests whose whole job is proving each preflight check can still fail | Nothing ever ran them. `tools/*` are workspace packages, but `pnpm test`'s runner only invoked the preflight *binary* and CI's `test-packages` filtered on `./packages/*`. The tests that guard the guards had never executed once. Found while adding the 56th (#99). |
| Three commits merged to `main`, nothing red in the Actions tab | Not a check that could not fail — a check that silently *did not run*. CI's concurrency group was one bucket for `main`, so each merge cancelled the previous merge's run; `cancelled` is neither red nor green, nothing reads it, and `deploy.yml` shipped each of those commits to preview anyway. The merged *combination* — the one thing a PR run never tests — went out untested three times (#103). |

So: when you add a guard, **break the code and watch the guard fail**, then restore. Say in the
issue comment which one you broke. When you fix something user-visible, look at it — curl the
deployed URL, read the actual bytes, take a viewport screenshot. Do not screenshot with
`captureBeyondViewport`; that is how a page nobody could scroll looked perfect for a week.

**And one more, #66: "verified on preview" was never safe to say.** `deploy.yml`'s own
"Verify /health reports this commit" step is not one of the seven above — it's correct at the
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
- **Turnstile now enforces on preview**, so you cannot exercise a write path with curl. Use the
  admin endpoints, `MOCK_AI`, or a real browser.
- **Email**: preview is `allowlist` (Kiarash and `leapkg@gmail.com` only), production is `live`.
  Reserved domains (`example.com`, `.test`, `.invalid`) are refused everywhere, which is why the
  repo's fixtures cannot bounce the sending domain. `EMAIL_MODE=test` bypasses the guard and a
  config test fails the build if it ever appears in `wrangler.toml`.
- **Name a new migration `YYYYMMDDHHMMSS_slug.sql`** (UTC — `date -u +%Y%m%d%H%M%S`), never
  `0009_slug.sql`. D1's `d1_migrations` ledger is keyed on the **filename**, and a sequential
  number is a shared namespace: two sessions cut from the same `main` both claim `0009`, the one
  that merges second must renumber on rebase, and renaming a file the shared preview has already
  applied makes the next deploy re-run its SQL. That broke `deploy (preview)` for every
  concurrent pull request once already (#99). The existing `0001`–`0008` stay exactly as they
  are — renaming them would *be* the bug. `node tools/preflight/preflight.mjs --only
  migrations,migration-drift` enforces both halves; `docs/runbooks/migrations.md` has the detail.
- **Never edit, rename or delete a migration that has landed on `main`, or that this branch has
  already pushed.** Add a new migration instead. There is no exception; a deploy cannot undo one.
- **The e2e suite runs entirely locally — use it, it is the best verification available.**
  `pnpm --filter @keepsake/web export` then `pnpm --filter @keepsake/web e2e` stands up real
  `workerd` with local D1/R2/KV via `wrangler dev` (see `apps/web/playwright.config.ts`), which is
  closer to production than preview ever was and needs no credentials. Baseline is ~80-82 passing.
  Now that pull requests no longer deploy anywhere, this is *the* way to verify a branch.
  - If Playwright reports `Executable doesn't exist at .../chromium_headless_shell-<n>/...`, the
    container's browser build predates the pinned `@playwright/test`. Do not run
    `playwright install` blindly; point the expected path at the build that is present. Concretely,
    with `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` holding a `-1194` build and Playwright asking
    for `-1243`, symlinking the present build under the expected name and filling in the two
    marker files (`INSTALLATION_COMPLETE`, `DEPENDENCIES_VALIDATED`) is enough — note the
    directory *and binary* also get renamed between builds
    (`chrome-linux/headless_shell` → `chrome-headless-shell-linux64/chrome-headless-shell`), so
    linking the folder alone still fails. All 82 specs pass on the older build; nothing about the
    suite needs the newer one.
  - `test/adminAuth.test.ts`'s brute-force case can time out at 30 s when the root runner fans API
    and web out concurrently on a loaded machine. Measured on both `main` and a feature branch with
    no difference, so it is load, not a regression — the flake its own comment and #65 describe.
    Re-run it alone before believing it.
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
- If a var changes, update **all three** `wrangler.toml` env blocks and `.env.example`, or
  preflight's parity check fails.

## Before you say you are done

```
pnpm lint                          # 0 errors; warnings are the zod const+type idiom
pnpm -r typecheck
pnpm test                          # preflight, packages, api, web
pnpm --filter @keepsake/web e2e    # 42+ specs, mobile and desktop
node tools/preflight/preflight.mjs
```

The accessibility specs carry **no exclusions**. If your change fails them, it is your change.

## Where the thinking is written down

- `docs/design/README.md` — status of record and milestone table.
- `docs/design/design-system.md` — the v3 "Polaroids on a table" identity. Two earlier rounds were
  rejected as generic; do not drift back to cream-and-serif cards.
- `docs/design/moderation.md` — how moderation works and two measured model weaknesses.
- `docs/runbooks/launch-audit.md` — 18 findings, several still open.
- `docs/legal-considerations.md` — compliance research, with eight questions marked for a lawyer.
- `docs/legal-entity-and-insurance.md` — why Keepsake is a sole proprietorship and not an LLC
  (#108), what has to be bought and filed because of that, and what would reverse it.
- `docs/runbooks/` — deploy, restore, migrations, admin, geodata, uk-block, issue-workflow.

## Writing for Kiarash

He reads the closing comment, not the diff. Say what changed, how you proved it, and what you did
not do. If a test passed but you did not verify the real thing, say that. He has repeatedly caught
problems by looking at the actual product on his phone; the fastest way to lose his trust is to
report success for something that was never observed working.

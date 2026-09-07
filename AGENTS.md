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

- **Preview**: <https://preview.keepsake.ing> — the whole product, live, on branch
  `give-flow-fixes`. Deploys itself on every push to `main`.
- **Production**: `keepsake-production` exists, migrated, seeded, secrets set — but **no domain
  points at it** and that is deliberate. Attaching `keepsake.ing` is Kiarash's call, and
  production deploys are manual (`workflow_dispatch`) because GitHub's required-reviewer gate is a
  paid feature on private repos.
- **The UK is geo-blocked on purpose** (`docs/runbooks/uk-block.md`). Not a bug.
- Work is tracked as GitHub issues across five milestones. Conventions in
  `docs/runbooks/issue-workflow.md`.

## Picking up work

1. `gh issue list --label "launch-blocker" --state open` — or browse a milestone.
2. **Skip anything labelled `status: in progress`.** That label is the lock; another session or a
   human is in those files right now.
3. Add `status: in progress`, comment saying what you intend to change, then work.
4. Reference the issue in commits (`Closes #12`, or `Refs #12` for partial work).
5. On finish, comment with **what changed and how you proved it**, then remove the label.

## The one rule that matters

**A passing test is not evidence. Verify the artifact.**

This project has shipped five separate checks that could not fail:

| What looked fine | What was actually true |
|---|---|
| Image moderation, tests green | The prompt showed the model a filled-in example, so it copied the safe answer instead of looking. Every score was decorative. |
| Bot-check site key configured | The bundler cached the inlined value; every build shipped an empty key, so the widget would never have rendered. |
| Accessibility suite green | Three real contrast bugs were inside named exclusions and could never fail it. |
| End-to-end suite green | The job was gated behind a job that only ran on API changes, so it had never once executed. |
| A rate limiter declared in every environment | It was called from nowhere. 320 parallel requests, 320 successes. |

So: when you add a guard, **break the code and watch the guard fail**, then restore. Say in the
issue comment which one you broke. When you fix something user-visible, look at it — curl the
deployed URL, read the actual bytes, take a viewport screenshot. Do not screenshot with
`captureBeyondViewport`; that is how a page nobody could scroll looked perfect for a week.

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
- `docs/runbooks/` — deploy, restore, admin, geodata, uk-block, issue-workflow.

## Writing for Kiarash

He reads the closing comment, not the diff. Say what changed, how you proved it, and what you did
not do. If a test passed but you did not verify the real thing, say that. He has repeatedly caught
problems by looking at the actual product on his phone; the fastest way to lose his trust is to
report success for something that was never observed working.

# Runbook: writing a D1 migration

Status: current (written 2026-09-07, issue #99).

**Name every new migration `YYYYMMDDHHMMSS_slug.sql`, in UTC.**

```sh
printf 'apps/api/migrations/%s_your_slug.sql\n' "$(date -u +%Y%m%d%H%M%S)"
```

Then write the SQL, ending every statement with `;`. That is the whole convention. The rest of
this page is why, and what happens if you get it wrong.

## The one fact everything else follows from

**D1 tracks applied migrations by filename.** `wrangler d1 migrations apply` reads the
`d1_migrations` table, takes the set of `name` strings it finds, and runs every file in
`apps/api/migrations/*.sql` whose *basename* is not in that set. There is no content hash and no
stable id. The filename **is** the primary key.

So renaming a migration that has already been applied somewhere de-registers it there. The next
deploy sees a name it has never run, runs the SQL again, and hits whatever the schema already
contains.

## What went wrong (#99), in order

1. A branch added `0007_notify_failed.sql`.
2. Preview deploys on **every open pull request** into **one shared database** (#66) — so
   preview's `d1_migrations` recorded `0007_notify_failed.sql` as applied.
3. PR #81 merged to `main` with a *different* `0007_admin_request_removal.sql`.
4. Rebasing put both files in the tree. Preflight's `migrations` check rejected the duplicate
   prefix (correctly), so the branch's file was renumbered to `0008_notify_failed.sql`.
5. The next preview deploy saw `0008_notify_failed.sql` as new, re-ran
   `ALTER TABLE requests ADD COLUMN notify_failed_reason TEXT`, and failed with
   `duplicate column name`.
6. `deploy (preview)` was then broken **for every concurrent pull request**, because they all
   deploy to the same database.

The bookkeeping was repaired by hand against the remote preview DB:

```sql
UPDATE d1_migrations SET name = '0008_notify_failed.sql' WHERE name = '0007_notify_failed.sql';
```

The column itself was already correct; only the ledger was wrong.

## Why timestamps

The sequential number is a **shared namespace claimed at the moment you write the file**. Two
sessions cut from the same `main` both look at `main`, both see `0006` as the highest, and both
write `0007`. Nothing about "branch from main and merge before you stop" prevents that — it is a
race, not a discipline problem, and this repo routinely has several sessions in flight
(`AGENTS.md`, "Picking up work").

Whoever merges second has to renumber. By then the shared preview has already applied the file
under the old name, and step 5 above happens.

A timestamp is claimed from the clock instead of from the state of `main`. Two branches cannot
collide, so a rebase never forces a rename, so the ledger never drifts.

**The existing `0001`–`0008` files are not renamed and never will be.** Renaming them to fit the
new convention would be exactly the bug this convention exists to prevent — they are already
applied under those names on preview and production.

### The ordering actually works

`wrangler d1 migrations apply` sorts by `parseInt(basename.split("_")[0], 10)` ascending, falling
back to a string compare only when two prefixes parse to the same number
(`wrangler-dist/cli.js`, `compareSegments` / `leadingMigrationNumber`).
`@cloudflare/vitest-pool-workers`'s `readD1Migrations` — which the `apps/api` test suite applies
against a fresh D1 on every run — sorts by the identical expression. A 14-digit timestamp parses
to ~2×10¹³, so every timestamped migration sorts after every four-digit one, forever.

Verified by running it, not by reading it. With two timestamped files added to the real
migrations directory:

```
$ wrangler d1 migrations apply keepsake-db --local --persist-to <fresh dir>
│ 0007_admin_request_removal.sql │ ✅ │
│ 0008_notify_failed.sql         │ ✅ │
│ 20260907090000_zz_probe.sql    │ ✅ │
│ 20260907100000_zz_probe2.sql   │ ✅ │
```

The probe was an `ALTER TABLE requests ADD COLUMN`, which only succeeds if `0001_init.sql` ran
first — so this is evidence of order, not just of membership.

### Do not use `wrangler d1 migrations create`

It names files `pad(max(existing numbers) + 1, 4)`. Against a timestamped set that produces
`20260907120001_slug.sql` — monotonic, so it would apply in the right order, but it is not a
timestamp and it re-introduces "claimed from the state of the tree". Use `date -u` as above.

## What the guards do

Two preflight checks, both in `tools/preflight/preflight.mjs`. Run them with
`node tools/preflight/preflight.mjs --only migrations,migration-drift`.

| Check | What fails it |
|---|---|
| `migrations` | filesystem only. A name that is neither `NNNN_slug.sql` nor a 14-digit UTC timestamp; a 14-digit prefix that is not a real instant (`20261307…`); two files sharing a prefix; a gap in the legacy `0001…N` block; a file whose last statement has no `;`; an apply order that would interleave the two schemes. |
| `migration-drift` | needs git. A migration that exists at `merge-base(origin/main, HEAD)` and has been **edited, renamed or deleted**; a migration this branch **committed and then removed or renamed**; a **newly added** migration using the legacy sequential form. |

`migration-drift` covers two distinct hazards. Rule one is the landed set: those files are applied
on preview *and production*, and touching them is unrecoverable-by-deploy. Rule two is this
branch's own history: preview redeploys on every push to an open pull request, so a migration you
committed and pushed is already in preview's ledger even though it has never been near `main` —
that is the #99 sequence exactly, and only the branch's own git history can see it.

### When it cannot run

`migration-drift` needs a baseline to diff against. If the tree is not a git work tree, or
`origin/main` does not resolve, or there is no merge base (a shallow clone), it reports **SKIP
with the reason and the words "this check did NOT run"** — never PASS. A check that silently
passes when it cannot run is the failure mode `AGENTS.md` catalogues five times over.

That SKIP becomes a **FAIL** when `GITHUB_ACTIONS=true` or `PREFLIGHT_REQUIRE_GIT_BASELINE=1`.
CI's `preflight` job checks out with `fetch-depth: 0`, explicitly fetches `origin/main`, and sets
`PREFLIGHT_REQUIRE_GIT_BASELINE=1` — so in CI a missing baseline is a red build, and the check
cannot be silently skipped where it matters. Locally, `git fetch origin main` is the fix.

## If you need to change a migration that has already been applied

You cannot. Add a new one.

- Wrong column type, missing index, bad backfill → new migration that alters/creates/fixes it.
- Migration was wrong and has only ever run on **local** databases → still add a new one if it has
  been pushed; the branch's preview deploy has applied it. Only if the commit that added it was
  never pushed may you amend or squash that commit away.
- The ledger is genuinely out of step with the schema on a **remote** database (someone renamed a
  file before these guards existed) → that is a manual `UPDATE d1_migrations SET name = …` against
  the remote DB, and it needs Cloudflare credentials only Kiarash has. Do not paper over it by
  renaming files to match.

## What is still not covered

Preview is one shared D1 for every open pull request (#66). These guards stop the *rename* that
corrupts its ledger; they cannot stop two branches whose migrations are individually fine from
applying **incompatible schema changes** to the same database, and they cannot stop a branch's
half-finished schema being live for everyone else's preview deploy. Only per-PR preview
environments with their own D1 (#73) remove that, and that is blocked on credentials and a
decision only Kiarash can make.

Nothing here was run against the real preview or production databases; every verification above
used `--local --persist-to` on a throwaway directory, or a throwaway git repository.

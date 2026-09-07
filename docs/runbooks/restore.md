# Runbook: restoring the database

Status: current (written 2026-09-06, launch audit finding 5). Before this file existed, a
repo-wide search for `backup|time.?travel|restore|d1 export|point.in.time` returned zero
operational hits: **D1 Time Travel, the actual recovery mechanism, was mentioned nowhere**, and
Kiarash would have had to discover it mid-incident from Cloudflare's docs, under pressure.

Read [Scope](#scope-what-this-does-and-does-not-recover) first. Then, if data is already gone,
skip to [If you need it right now](#if-you-need-it-right-now).

## What was actually executed, and what is written from the docs

Every command below was run against **preview** or against a throwaway database
(`keepsake-db-restore-drill`, created and deleted on 2026-09-06). Nothing in this file was run
against production.

| Step | Status |
|---|---|
| `wrangler d1 time-travel info <db>` — current bookmark | **executed** (preview) |
| `wrangler d1 time-travel info <db> --timestamp <rfc3339>` — bookmark for a past moment | **executed** (preview) |
| `wrangler d1 time-travel restore <db> --bookmark <b>` — real restore, verified by deleting a row and getting it back | **executed** (drill database) |
| `wrangler d1 export --no-schema --table …` — data-only backup | **executed** (preview, 11 KB, ~3 s) |
| `wrangler d1 create` + apply migrations + `d1 execute --file <export>` — restore into a *new* database | **executed** (drill database; row counts matched preview exactly) |
| FTS survives that path | **executed** — `listings_fts` repopulated via its triggers, `MATCH 'compass'` returned the expected row |
| Re-pointing `wrangler.toml` at the new `database_id` and deploying | **not executed** — written from the deploy runbook; it is an ordinary deploy |
| R2 photo recovery | **there is none.** See [Scope](#scope-what-this-does-and-does-not-recover) |

Two things worth knowing before you need them, both discovered by running the commands:

- **`wrangler d1 export` fails outright on this database** with
  `D1 Export error: cannot export databases with Virtual Tables (fts5)`. Migration `0003_fts.sql`
  creates `listings_fts`, so a plain `wrangler d1 export keepsake-db-production` — the exact
  command the launch audit proposed putting on a weekly schedule — **does not work**. Every export
  in this file therefore names its tables explicitly with `--table`, which does work.
- **A `--timestamp` older than the database itself fails** with a bare
  `internal error … [code: 7500]`, not a useful message. On a database created minutes ago that is
  expected; on production it means you asked for a moment outside the 30-day window.

## Scope: what this does and does not recover

**D1 (all listings, owners, requests, reports, moderation history, email ledger): recoverable.**
Time Travel is on by default with 30 days of retention and needs no setup, no cron and no bucket.

**R2 (every photo byte): not recoverable.** `wrangler.toml` declares the bucket with nothing but
`binding` and `bucket_name` — no versioning, no lifecycle rule — and `orphanSweep`
(`src/cron/orphanSweep.ts`) calls `BUCKET.delete()` unconditionally. Time Travel restores the
`photos` rows; the bytes those rows point at stay gone, and `/i/:id/:variant` 404s for every one.
**A restore that brings back listings whose photos are deleted is a half-restore, and there is
currently no second half.** If you do nothing else with this document, know that.

**Worker code: not this document.** See `docs/runbooks/deploy.md`.

## RPO and RTO, honestly

**RPO ≈ 0 for D1, within a 30-day window.** Time Travel is not a snapshot schedule — D1 keeps the
write-ahead log and a bookmark identifies an exact commit, so you restore to *the state before the
bad statement*, not to the last nightly dump. `d1 time-travel info --timestamp` resolved a
one-hour-old RFC3339 timestamp to a bookmark on preview on the first try. Past 30 days there is
nothing at all.

**RPO for R2 is total.** Deleted photo bytes are unrecoverable at any age.

**RTO ≈ 2 minutes** for an in-place Time Travel restore (the drill's restore returned in seconds;
budget for finding the right bookmark). **RTO ≈ 20-40 minutes** for the restore-into-a-new-database
path below, dominated by re-seeding `postal_codes`.

## If you need it right now

```sh
cd apps/api
DB=keepsake-db-production        # or keepsake-db-preview

# 1. Where are we now? Write this bookmark down — it is your undo.
pnpm exec wrangler d1 time-travel info "$DB"

# 2. Find the bookmark for a moment before the damage.
pnpm exec wrangler d1 time-travel info "$DB" --timestamp 2026-09-06T17:45:00Z

# 3. Restore, in place, to that bookmark.
pnpm exec wrangler d1 time-travel restore "$DB" --bookmark <bookmark-from-step-2>
```

Step 3 prompts (`OK to proceed (y/N)`, with `In-flight queries and transactions will be
cancelled`) and, on success, prints the bookmark that undoes it:

```
✅ Database keepsake-db-restore-drill restored back to bookmark 00000000-0000002f-…
↩️ To undo this operation, you can restore to the previous bookmark: 00000000-ffffffff-…
```

**Copy that undo bookmark somewhere before you do anything else.** Restoring is itself a write,
and it is the thing you will want to reverse if you picked the wrong moment.

Verified end to end on the drill database: insert a row → take a bookmark → delete the row →
`SELECT COUNT(*)` returns 0 → restore to the bookmark → `SELECT COUNT(*)` returns 1.

Notes that matter under pressure:

- `--timestamp` accepts RFC3339 (`2026-09-06T17:45:00Z`) or Unix seconds, and must be inside the
  last 30 days. An out-of-range timestamp fails with an opaque `internal error … [code: 7500]`.
- The restore replaces the live database. It does not create a copy. If you would rather not
  overwrite what is there, use the next section instead.
- Time Travel is per-database, and preview and production are separate databases
  (`2cfbc1c8-…` / `ef57b121-…`) — restoring one cannot affect the other.

## Taking a backup you can hold in your hand

Time Travel is enough for almost every incident and needs no maintenance. An export is for the
cases it cannot cover: a mistake older than 30 days, an account-level problem, or wanting a copy
somewhere that is not Cloudflare.

`wrangler d1 export <db>` on its own **errors** here — `cannot export databases with Virtual Tables
(fts5)`. Name the real tables instead:

```sh
cd apps/api
pnpm exec wrangler d1 export keepsake-db-production --env production --remote --no-schema \
  --output "keepsake-$(date -u +%Y%m%dT%H%M%SZ).sql" -y \
  --table owners --table listings --table photos --table requests --table reports \
  --table moderation_events --table recovery_tokens --table email_events
```

- `--no-schema` is deliberate: the export contains **no `CREATE INDEX` and no `CREATE TRIGGER`**
  (verified — zero of each in the file). Importing a schema-ful export would give you tables with
  no indexes and, worse, no FTS triggers, so search would silently stop updating. Migrations own
  the schema; the export owns the rows.
- `postal_codes` is deliberately excluded. It is ~3.4 MB of the database's 3.6 MB, it is
  reproducible from `apps/api/seeds/postal_codes.sql`, and re-seeding it is one command
  (see below).
- `listings_fts*` and `_cf_KV` are excluded because they are derived or internal. FTS is rebuilt
  from `listings`, which is in the export.
- Measured on preview: 11 KB, about 3 seconds. On production it stays small for a long time —
  this is text, and the photos (the actual bulk) live in R2.

Keep the file somewhere that is not this Cloudflare account. There is deliberately **no scheduled
export workflow**: an unattended weekly job writing into the same account's R2 would not survive
the account-level failure it is supposedly for, and it would be one more thing that can rot
unnoticed — which is the failure mode this whole audit is about. Run this by hand before anything
risky (a migration that drops or rewrites a column, a bulk admin action), and note in
`docs/runbooks/incident.md` that you did.

## Restoring into a new database, then cutting over

Use this when you want the old data back **without** overwriting what is live — the usual case
when you need to compare, or when the damage is subtle and you are not yet sure which state is
correct.

Executed on the drill database on 2026-09-06; row counts came out identical to preview
(`owners` 14, `listings` 1, `photos` 3, `email_events` 7).

```sh
cd apps/api

# 1. New, empty database. Note the database_id it prints.
pnpm exec wrangler d1 create keepsake-db-production-restore

# 2. Schema, from the migrations — in order. This is what creates the indexes and
#    the listings_fts triggers that the export does not carry.
#    (`d1 migrations apply` needs a binding in wrangler.toml; executing the files
#    directly by database name needs no config edit, which is what you want mid-incident.)
for f in migrations/0001_init.sql migrations/0002_geo.sql migrations/0003_fts.sql migrations/0004_email_events.sql; do
  pnpm exec wrangler d1 execute keepsake-db-production-restore --remote --file "$f" -y
done

# 3. Rows. There is no `wrangler d1 import`; `execute --file` is the import.
pnpm exec wrangler d1 execute keepsake-db-production-restore --remote --file keepsake-<stamp>.sql -y

# 4. Postcodes — NOT in the export, and the app 404s every postcode lookup without them.
#    `GET /api/admin/health` reports `postal_codes_count: 0` and `ok: false` until this runs.
pnpm exec wrangler d1 execute keepsake-db-production-restore --remote \
  --file seeds/postal_codes.sql -y

# 5. Check it before you point anything at it.
pnpm exec wrangler d1 execute keepsake-db-production-restore --remote \
  --command "SELECT (SELECT COUNT(*) FROM listings) AS listings, (SELECT COUNT(*) FROM owners) AS owners, (SELECT COUNT(*) FROM postal_codes) AS postal_codes"
```

**FTS needs no separate step on this path.** `listings_fts` is an external-content FTS5 table fed
by `AFTER INSERT/UPDATE/DELETE` triggers on `listings` (`migrations/0003_fts.sql`), and step 2
creates those triggers before step 3 inserts any rows — so the index is built as the data lands.
Confirmed on the drill database: after the import, `listings_fts` held one row and
`SELECT COUNT(*) FROM listings_fts WHERE listings_fts MATCH 'compass'` returned 1.

If you ever restore rows into a database whose triggers were **not** in place first (a
schema-ful export, a hand-built table), repair the index rather than reimporting:

```sh
pnpm exec wrangler d1 execute <db> --remote --command "INSERT INTO listings_fts(listings_fts) VALUES('rebuild')"
```

### Cutover

Not executed — this is an ordinary deploy, and doing it for real would have deployed to a live
tier.

1. Edit `apps/api/wrangler.toml`: replace `database_id` under `[[env.production.d1_databases]]`
   with the new database's id. Leave `database_name` alone or update both together — Wrangler
   binds by id.
2. Deploy: run the `Deploy` workflow from the Actions tab with `environment: production` (per
   `docs/runbooks/deploy.md`, production is `workflow_dispatch`-only). The workflow applies
   migrations before deploying, which is a no-op here because step 2 above already applied them.
3. Confirm: `curl -s https://keepsake.ing/health | jq` reports `ok: true` and the new commit, and
   `GET /api/admin/health` reports a non-zero `postal_codes_count`.
4. Keep the old database. Do not delete it the same day. `wrangler d1 delete <name>` is
   irreversible and Time Travel does not survive the database it belonged to.

### Re-seeding `postal_codes`

Any path that starts from an export needs this; an in-place Time Travel restore does not (the
table comes back with everything else).

```sh
cd apps/api
pnpm exec wrangler d1 execute keepsake-db-production --env production --remote \
  --file seeds/postal_codes.sql -y
```

~46k rows across US/CA/GB, batched as `INSERT OR REPLACE` — idempotent, so re-running it is safe
and a partial load can simply be repeated. (The GB rows are dormant since the 2026-09-06 UK
geo-block — see [uk-block.md](uk-block.md) — but restoring them is still correct: they're inert,
harmless data, not reachable through the API.) `seeds/postal_codes.sql` is stored in Git LFS: if
the file is a few hundred bytes it is an unfetched pointer, not the seed — `git lfs pull` first.
Full details, including regenerating from GeoNames, in [geodata.md](geodata.md).

## After any restore

- `curl -s <site>/health | jq` — bindings and D1 reachable.
- `GET /api/admin/health` — `postal_codes_count > 0`, and `cron_last_run` fresh for both jobs
  (`ok` is false if either heartbeat is stale; see `docs/runbooks/admin.md`).
- Search still works: `GET /api/feed?q=<a word you know is in a listing>` returns it. This is the
  one thing a restore can break silently, because an empty FTS index looks exactly like "no
  results".
- Spot-check a photo: open a listing's `/i/:id/thumb`. A 404 here is the R2 half of
  [Scope](#scope-what-this-does-and-does-not-recover) — the rows are back and the bytes are not.
- Write down which bookmark you restored to, and the undo bookmark, in the incident notes.

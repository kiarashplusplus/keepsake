# Runbook: restoring the database and photo bytes

Status: current (D1 sections written 2026-09-06, launch audit finding 5; R2 section added
2026-09-07, issue #17). Before this file existed, a repo-wide search for
`backup|time.?travel|restore|d1 export|point.in.time` returned zero operational hits: **D1 Time
Travel, the actual recovery mechanism, was mentioned nowhere**, and Kiarash would have had to
discover it mid-incident from Cloudflare's docs, under pressure. R2 had nothing at all to find —
see [R2 photo backup](#r2-photo-backup) below.

Read [Scope](#scope-what-this-does-and-does-not-recover) first. Then, if data is already gone,
skip to [If you need it right now](#if-you-need-it-right-now) for D1, or
[R2 photo backup](#r2-photo-backup) for a deleted photo.

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
| `wrangler r2 bucket create <name>-backup` — second bucket per environment | **executed** (preview only; production blocked, see [R2 photo backup](#r2-photo-backup)) |
| `wrangler r2 bucket lifecycle add <backup-bucket> --expire-days 400` | **executed** (preview only) |
| `node tools/backup-photos.mjs --env preview` — copy every referenced photo into the backup bucket | **executed** (preview, twice: 7 copied + 1 skipped, then 8/8 skipped on rerun) |
| Delete-then-restore drill: put an object, back it up, delete it from primary, confirm 404, restore from backup, confirm byte-identical | **executed** (preview, synthetic key, cleaned up after) |

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

**R2 (every photo byte): partially recoverable, as of 2026-09-07.** `wrangler.toml`'s primary
bucket still declares nothing but `binding` and `bucket_name` — no native versioning exists to
turn on (see [R2 photo backup](#r2-photo-backup) for what was actually checked) — and
`orphanSweep` (`src/cron/orphanSweep.ts`) still calls `BUCKET.delete()` unconditionally. What
changed: a second bucket per environment (`<name>-backup`) now holds a copy of every currently
referenced photo, populated by `tools/backup-photos.mjs`, and a photo deleted from the primary
bucket by a buggy predicate can be copied back from there. Time Travel restores the `photos` rows
in D1 regardless; whether `/i/:id/:variant` 404s afterward now depends on whether that photo had
already been copied to the backup bucket — see below for exactly what that does and does not
cover. **This is still not equivalent to D1's coverage**: D1 protects every row for 30 days
automatically with nothing to run; R2's protection here only covers a key once something has run
`tools/backup-photos.mjs` against it, and the backup lives in the same Cloudflare account it
insures against (more on both below).

**Worker code: not this document.** See `docs/runbooks/deploy.md`.

## RPO and RTO, honestly

**RPO ≈ 0 for D1, within a 30-day window.** Time Travel is not a snapshot schedule — D1 keeps the
write-ahead log and a bookmark identifies an exact commit, so you restore to *the state before the
bad statement*, not to the last nightly dump. `d1 time-travel info --timestamp` resolved a
one-hour-old RFC3339 timestamp to a bookmark on preview on the first try. Past 30 days there is
nothing at all.

**RPO for R2 depends on when `tools/backup-photos.mjs` last ran against the key in question** — see
[R2 photo backup](#r2-photo-backup). Nothing is instant and nothing is guaranteed the way D1's
write-ahead log is; a photo uploaded and deleted between two runs of the script is still
unrecoverable at any age, same as before.

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
#    Glob every migration rather than naming them: this loop was written when there
#    were four, and a hard-coded list silently restores an OLD SCHEMA the moment a
#    fifth lands. `ls` sorts 0001..0009 ahead of the 14-digit timestamps, which is
#    the same order wrangler applies them in (docs/runbooks/migrations.md).
for f in $(ls migrations/*.sql | sort); do
  echo "applying $f"
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

**Check the count before moving on:** `ls migrations/*.sql | wc -l` and the number of lines the
loop printed must agree. When this section was first written the tree held four migrations and the
loop named all four by hand; the tree holds ten today (`0001`–`0009` plus one timestamped), and a
restore that applied only the original four would come back missing `listing_aspects`,
`requests.notify_failed_reason` and the email-event diagnostic columns — with every query against
them failing at runtime rather than at restore time.

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
- `GET /api/admin/health` — `postal_codes_count > 0`, and `cron_last_run` fresh for all **three**
  jobs (`moderationRetry`, `orphanSweep`, `dailyDigest`). `ok` is false if any heartbeat is stale,
  if postcodes are missing, or if auto-hidden reports are awaiting review; see
  `docs/runbooks/admin.md`. On a freshly restored KV namespace every heartbeat is missing, which
  counts as stale — `moderationRetry` clears within five minutes, the two nightly jobs on their
  next run, so `ok: false` immediately after a restore is expected and is not itself a finding.
- Search still works: `GET /api/feed?q=<a word you know is in a listing>` returns it. This is the
  one thing a restore can break silently, because an empty FTS index looks exactly like "no
  results".
- Spot-check a photo: open a listing's `/i/:id/thumb`. A 404 here means the bytes are gone and
  weren't in the backup bucket either — see [R2 photo backup](#r2-photo-backup) to check and
  restore from there before concluding the photo is unrecoverable.
- Write down which bookmark you restored to, and the undo bookmark, in the incident notes.

## R2 photo backup

Issue #17. Before this section existed, `wrangler.toml` declared the photo bucket with nothing
but `binding` and `bucket_name`, and a bug in either of `orphanSweep`'s two photo-deleting sweeps
(`sweepOrphanPhotos`, `sweepTerminalListingPhotos` — the other three sweeps touch D1 rows only)
(`apps/api/src/cron/orphanSweep.ts`) destroyed a photo with no way back — D1 Time Travel restores
the `photos` row, but the bytes it points at stay gone forever.

### What was checked, not assumed

R2 bucket versioning does not exist to enable. Checked directly, `wrangler` 4.129.0 against this
account, 2026-09-07:

```
$ wrangler r2 bucket --help
COMMANDS
  wrangler r2 bucket create <name>
  wrangler r2 bucket update
  wrangler r2 bucket list
  wrangler r2 bucket info <bucket>
  wrangler r2 bucket delete <bucket>
  wrangler r2 bucket sippy       # incremental migration *into* R2 from AWS/GCS — wrong direction
  wrangler r2 bucket catalog     # Iceberg REST interface — unrelated
  wrangler r2 bucket notification
  wrangler r2 bucket domain
  wrangler r2 bucket dev-url
  wrangler r2 bucket local-uploads
  wrangler r2 bucket lifecycle   # expire / transition storage class / abort multipart — no undelete
  wrangler r2 bucket cors
  wrangler r2 bucket lock        # WORM retention — prevents deletion, doesn't recover one
```

No `versioning` subcommand, and `wrangler r2 bucket info <bucket> --json` returns
`name`/`created`/`location`/`default_storage_class`/`object_count`/`bucket_size` — no
versioning-related field. `lifecycle` only expires objects, transitions storage class, or aborts
incomplete multipart uploads — every one of those *removes* data on a schedule, none of them
brings a deleted object back. `lock` (Object Lock/WORM retention) prevents deletion for a
retention window, which is real protection against an accidental delete but would also block
`orphanSweep`'s legitimate deletes on the *primary* bucket, so it isn't usable there. **Conclusion:
there is nothing to turn on.** The honest alternative the issue asks for is what follows.

### What was built: a second bucket, populated by a script that was actually run

`tools/backup-photos.mjs` — reads `apps/api/wrangler.toml` for each environment's D1 database and
primary bucket name (so it can't drift from what actually deploys), queries D1 for every
`r2_key_full`/`r2_key_thumb` currently referenced by a `photos` row, and copies any key not
already present in `<bucket>-backup` from the primary bucket into it. It never deletes anything
from the backup bucket — that is deliberate: it's what makes the backup resistant to the exact bug
class this issue is about (a buggy `orphanSweep` predicate deletes a live photo from the primary
bucket and its D1 row); a copy made before that run is untouched by it.

Executed against preview, 2026-09-07 (`keepsake-photos-preview-backup`, created the same day):

```
$ node tools/backup-photos.mjs --env preview
backup-photos: env=preview db=keepsake-db-preview primary=keepsake-photos-preview backup=keepsake-photos-preview-backup
backup-photos: 8 referenced key(s) in D1
  + copied photos/01M1TEVQ36RCJXNTTEHCTNT1SY/thumb.png
  + copied photos/01M1VS7RCTD6S2KBWE6DA7JTS0/full.jpg
  + copied photos/01M1VS7RCTD6S2KBWE6DA7JTS0/thumb.jpg
  + copied photos/01M1VY4D2D7170XPMDJYYHXVSD/full.jpg
  + copied photos/01M1VY4D2D7170XPMDJYYHXVSD/thumb.jpg
  + copied photos/01M1WKNDSSC5Z2EQM40Q0WK5AF/full.jpg
  + copied photos/01M1WKNDSSC5Z2EQM40Q0WK5AF/thumb.jpg
backup-photos: done — copied=7 skipped=1 (already backed up) failed=0

$ node tools/backup-photos.mjs --env preview   # rerun, proving idempotency
backup-photos: 8 referenced key(s) in D1
backup-photos: done — copied=0 skipped=8 (already backed up) failed=0
```

(The one pre-existing "skipped" on the first run was a manual test copy made while verifying the
`get`/`put` commands before writing the script; the second run's 8/8 skip is the real idempotency
proof.) A `shasum -a 256` of a primary object and its backup copy matched exactly.

`wrangler r2 bucket info <bucket>` reports `object_count`/`bucket_size` from a lagging aggregate —
it read `0` immediately after the first run populated the bucket. Don't use it to check whether a
specific object exists; `wrangler r2 object get <bucket>/<key>` (exit 0/1) is the reliable check,
and it's what the script itself uses.

### Restoring a deleted photo

```sh
cd apps/api
KEY="photos/<id>/full.jpg"          # or thumb.jpg — from the photos row, or from the 404'ing URL
BUCKET=keepsake-photos-preview      # or -production
pnpm exec wrangler r2 object get "$BUCKET-backup/$KEY" --remote -f /tmp/restore.bin
pnpm exec wrangler r2 object put "$BUCKET/$KEY" --remote -f /tmp/restore.bin
```

**Proven end to end on preview, 2026-09-07, with a synthetic key** (not a real listing's photo —
this drill intentionally never touched user-visible data): uploaded a test object to the primary
bucket, copied it to the backup bucket, deleted it from primary (simulating a buggy `orphanSweep`
predicate), confirmed `wrangler r2 object get` on primary exits `1` ("The specified key does not
exist"), restored it with the two commands above, confirmed primary answers again with exit `0`,
and confirmed the restored bytes are byte-identical to the original before cleaning up both
copies. The exit codes above were checked directly (`echo $?` immediately after the wrangler
command, not after a pipe to `tail` — piping through `tail` reports `tail`'s exit status, not
wrangler's, and would have silently hidden a real failure here).

If the key was never backed up (created and deleted between two runs of the script, or the script
has never been run for that environment), this fails at the first `get` and the photo is gone —
same as the "no recovery path" state before this issue, just narrower.

### Bounding growth

The script never deletes from the backup bucket, so left alone it would grow forever, including
photos of listings `orphanSweep` has since correctly removed. `keepsake-photos-preview-backup` has
its own lifecycle rule, set once by hand (not by the script):

```sh
pnpm exec wrangler r2 bucket lifecycle add keepsake-photos-preview-backup \
  expire-after-400d --expire-days 400 -y
```

400 days is comfortably longer than D1's 30-day Time Travel window and `orphanSweep`'s 30-day
terminal-photo grace period, so the backup outlives every other recovery mechanism in this
document rather than expiring a photo those mechanisms would still consider live.

### The ordering is enforced by the sweep

Issue #178. This runbook used to state, as a fact and one paragraph above the timestamp that
contradicts it, that the backup runs before `orphanSweep` and therefore always copies a photo
before the sweep can delete it. The backup was scheduled at 03:00 and the sweep's cron is 03:17:
seventeen minutes of margin against GitHub's `schedule:` queue, which GitHub documents as
best-effort. Measured drift on this repository is regularly larger than that — `report-pressure.yml`
has started up to 18 minutes late — and **the one scheduled run `backup-photos.yml` has ever had
started at 03:18, after the sweep's trigger.**

When the sweep wins that race it deletes the R2 objects and the `photos` row; the backup then
queries D1, no longer sees the row, copies nothing, and exits green. The bytes are gone with no
copy anywhere, and a green run looks identical to a quiet one.

So `orphanSweep` now reads the backup bucket itself and **refuses to delete a photo whose two keys
are not already there** (`PHOTO_BACKUP_BUCKET` in `apps/api/wrangler.toml`, `isBackedUp` in
`apps/api/src/cron/orphanSweep.ts`). A late backup delays a deletion by a night instead of losing
bytes. Deferrals are counted in the sweep's `orphanSweep: done` log line as `photosDeferred`, and
a `console.warn` names them — a non-zero count on one night is the guard working; a non-zero count
every night means the backup workflow has stopped, and orphan cleanup has stopped with it.

**Production runs without that guard today, on purpose.** `keepsake-photos-production-backup` does
not exist (#157), so `wrangler.toml` deliberately declares `PHOTO_BACKUP_BUCKET` at the top level
and under `[env.preview]` only. With the binding absent the sweep deletes as it always did and
logs a warn saying deletion is running unguarded — because refusing every deletion for want of a
bucket nobody has created would turn one missing resource into unbounded R2 growth and a `photos`
table nothing prunes. **Creating that bucket and uncommenting the four lines under
`[env.production]` is the second half of #157**, and it is what turns the guard on for the live
site.

### What this does not fix

**The backup bucket is in the same Cloudflare account as the bucket it insures against.** This is
the exact weakness this document already names for the D1 export path (see
[Taking a backup you can hold in your hand](#taking-a-backup-you-can-hold-in-your-hand)): an
account-level failure — suspension, compromise, a Cloudflare-side R2 incident — takes both buckets
out together, and this script does nothing about that. It protects against the risk that is
actually live right now (an application bug deleting a photo it shouldn't have) and not against
the account-level risk restore.md already flags as the harder problem. Getting a copy of photo
bytes to a genuinely separate provider (a second Cloudflare account, or an S3/GCS bucket via
Sippy's *other* direction or a direct upload) needs credentials that don't exist in this
environment and is Kiarash's call to provision — not something to fake by writing a script that
would work if the credentials existed.

**Production has no backup bucket yet.** `wrangler r2 bucket create keepsake-photos-production-backup`
was attempted and blocked by this environment's own safety controls (a production-write action
requires explicit approval this session didn't have). The one-time setup, for whoever has that
approval:

```sh
cd apps/api
wrangler r2 bucket create keepsake-photos-production-backup
wrangler r2 bucket lifecycle add keepsake-photos-production-backup expire-after-400d --expire-days 400 -y
node tools/backup-photos.mjs --env production
```

**The cron fires, and its production leg has not yet proved anything.**
`.github/workflows/backup-photos.yml` runs `tools/backup-photos.mjs` for both tiers, at 01:00 UTC
since #178 (03:00 before that). **That time is not what keeps a photo safe** — see
[The ordering is enforced by the sweep](#the-ordering-is-enforced-by-the-sweep) below, which is
the correction to what this paragraph used to claim. It has fired once on its `schedule:`
trigger —
[run 34079182574](https://github.com/kiarashplusplus/keepsake/actions/runs/34079182574),
2026-09-07 03:18 UTC, both legs green — which retires the "no green Actions run is possible yet"
caveat this paragraph used to carry (a workflow file GitHub has never seen on the default branch
gets neither `schedule:` nor `workflow_dispatch`; merging fixed that).

**That green was the shape `AGENTS.md`'s table warns about, and it has been fixed.** The
production leg's whole log read `0 referenced key(s) in D1` — production had no `photos` rows at
03:18 that morning — so the job did no work, touched no bucket, and passed. It proved nothing
about whether `keepsake-photos-production-backup` exists, and it would have gone on passing until
the first production photo, at which point the `put` fails and the bytes it was meant to protect
never were.

`tools/backup-photos.mjs` now **probes the backup bucket before the key count can make the run
trivially green** (`wrangler r2 bucket info`, account-level and read-only) and exits 1 if it cannot
confirm it, printing wrangler's own stderr verbatim plus the two create commands. It also says
plainly when there is nothing to copy, rather than letting a silent success read as "photos are
backed up." So a green run now means at minimum "the destination exists"; before, it could mean
nothing at all.

The failure is deliberately not diagnosed past what is honest: a non-zero exit means *could not
confirm*, which is a missing bucket **or** absent/too-narrow credentials. Wrangler's message
distinguishes them; the script does not guess.

Verified by breaking it: with the check commented out the script sails past to the D1 query, and
the "confirmed present" line no longer prints at all — it is emitted inside the check rather than
by the caller, after a first draft where commenting the call out still printed it, which is the
same bug one level up. Restored, it stops at the bucket probe with the new message.

**Production still has no backup bucket as far as anyone can show** (the paragraph above stands).
What has changed is that the next scheduled run will now say so out loud instead of passing.
Still: read the run's log, not just its check mark, and confirm `copied` is non-zero before
treating production photos as backed up.

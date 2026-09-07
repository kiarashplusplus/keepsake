/**
 * M4: nightly cleanup for the Worker's own accumulated cruft, per the plan's
 * cron table and Risks #8 (orphan-upload abuse):
 *
 *  - `photos` rows never attached to a listing (`listing_id IS NULL`), plus
 *    their two R2 objects, once they're more than 24h old — abandoned
 *    `give` flows and abuse probes both leave these behind. Deleted in
 *    batches of 100 so one run never holds a single giant transaction.
 *  - `recovery_tokens` more than 7 days past their own `expires_at` — an
 *    expired token is already useless the moment it expires; the extra week
 *    before deletion only exists so a support conversation about "did I
 *    actually request this" has a row to look at, not because an expired
 *    token is still valid for anything.
 *  - `moderation_events` / `email_events` older than 90 days — the queue's
 *    own audit log and the email-attempt ledger, both unbounded-growth
 *    tables nothing else here ever prunes.
 *  - `owners` rows with nothing attached to them — no listing, no photo, no
 *    email, no recovery token — last seen more than 30 days ago (launch audit
 *    finding 11).
 *  - the R2 objects behind photos of listings that have been `rejected`,
 *    `withdrawn` or `hidden` for more than 30 days (launch audit finding 15).
 *  - `requests.ip_digest` / `reports.ip_digest` on rows older than 48 hours
 *    (issue #169), which is what makes the privacy page's twice-stated
 *    48-hour expiry true of the D1 copies and not only of the KV counters.
 *
 * Since #178 the two photo sweeps also consult the backup bucket
 * (`PHOTO_BACKUP_BUCKET`) and refuse to delete a photo whose keys are not
 * already copied there, so the ordering between this job and the nightly
 * backup workflow is enforced here rather than by two independent schedulers.
 * When that binding is absent — production has no backup bucket yet, #157 —
 * deletion proceeds as before and says so loudly. See `isBackedUp`.
 *
 * Every condition is purely time-based, so re-running this twice in a row
 * (a retried cron invocation, a manual trigger) is a no-op the second time:
 * nothing already deleted can match the same `WHERE` clause again.
 */
import type { Env } from "../env.js";
import { isDeployed, photoBackupBucket } from "../env.js";
import { purgePhotoCache } from "../lib/photoCache.js";

const ORPHAN_PHOTO_AGE_MS = 24 * 60 * 60 * 1000;
const RECOVERY_TOKEN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Issue #169. `apps/site/public/privacy.html` promises, in two places, that
 * a hashed IP expires after 48 hours. That was true of the KV budget
 * counters (`moderation/budget.ts`'s `expirationTtl`) and false of the two
 * D1 columns holding the *same* `dailyIpDigest` value: `requests.ip_digest`
 * and `reports.ip_digest` had no TTL, no sweep and no delete path, and the
 * requester's own withdraw link deliberately left the hash behind. Three
 * years after someone asked for a keepsake and then withdrew the ask, the
 * hash of their address on the day they used the site was still in D1.
 *
 * The promise is load-bearing rather than decorative. The paragraph that
 * makes it concedes, correctly, that an IPv4 preimage is brute-forceable by
 * anyone who knows the day — and `created_at` sits in the same row. "It is
 * gone within 48 hours" is the sentence that makes that concession
 * acceptable.
 *
 * Nulling costs no enforcement: both columns back day-scoped uniqueness
 * checks ("has this address already reported this listing today", read at
 * `routes/listings.ts`), and `lib/digest.ts` hashes `<day>:<ip>`, so a digest
 * from any earlier day can never match today's and is never consulted.
 *
 * The number is asserted from the other side by
 * `apps/web/test/guards/privacyPolicy.test.ts`, which reads this constant out
 * of this file and the sentence out of the page, so the two cannot drift
 * apart again. This is the fourth false claim that page has shipped; a
 * retention promise with no test behind it is how it recurred.
 */
const IP_DIGEST_RETENTION_MS = 48 * 60 * 60 * 1000;

/**
 * Launch audit finding 11. An `owners` row is minted for any well-formed
 * `ks_…` token that reaches `ownerAuth({ createIfMissing: true })`, and until
 * now nothing ever removed one — no sweep, no delete-account path, nowhere.
 * Every owner lookup queries that table.
 *
 * The rate-limit reorder on `PUT /api/photos` and `POST /api/listings` bounds
 * the *rate* of new junk rows; this bounds the total. 30 days of no activity
 * before an empty row is collected: a giver who uploads a photo, closes the
 * tab and comes back in a fortnight still finds their dashboard, and one who
 * has attached nothing at all in a month has no dashboard to lose — there is
 * nothing in the row to show them.
 */
const EMPTY_OWNER_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Launch audit finding 15: photos of `rejected`, `withdrawn` and `hidden`
 * listings were kept forever. `sweepOrphanPhotos` only ever sees
 * `listing_id IS NULL`, and every one of those transitions mutates
 * `listings.status` alone, leaving `photos.listing_id` set — so those R2
 * objects were swept by nothing, ever, while `privacy.html` promised they are
 * kept "for as long as the listing exists, plus a short grace period after
 * it's removed".
 *
 * 30 days is that grace period, and it is chosen against the appeal path
 * rather than against storage cost. `hidden` is reversible (admin `restore`,
 * and three reports auto-hide a listing that may be entirely innocent), and
 * `withdrawn` is re-listable by the owner, so the window has to be long enough
 * for a human to notice and act — a month is far past the hours-to-days that
 * realistically takes, and it matches the D1 Time Travel window a mistaken
 * mass-hide would be recovered through (`docs/runbooks/restore.md`).
 *
 * `given` is deliberately *not* terminal for this purpose: a given listing is
 * still individually reachable at `/item/:id`, and a page that renders with a
 * missing photo is worse than one that keeps it.
 */
const TERMINAL_PHOTO_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const TERMINAL_STATUSES = ["rejected", "withdrawn", "hidden"] as const;

const PHOTO_BATCH_SIZE = 100;
/** Safety bound on the number of batches processed in a single run — at
 * 100/batch that's 500,000 rows, far past any real backlog. Exists only so a
 * pathological backlog can't turn one cron tick into an unbounded loop;
 * whatever's left over is picked up by tomorrow night's run. */
const MAX_PHOTO_BATCHES = 5000;

interface OrphanPhotoRow {
  id: string;
  r2_key_full: string;
  r2_key_thumb: string;
}

/**
 * Issue #178. **The ordering between the backup and this sweep is enforced
 * here, by the deleter, and not by two independent clocks.**
 *
 * `.github/workflows/backup-photos.yml` copies every referenced photo into
 * `<bucket>-backup`, and its entire safety argument used to be that GitHub
 * starts it before this cron fires. It does not reliably: GitHub's
 * `schedule:` queue is best-effort, measured drift on this repository is
 * routinely larger than the margin the schedules left, and the one scheduled
 * run that workflow has ever had started *after* the sweep's trigger. When
 * that happens the sweep deletes the R2 objects and the `photos` row, the
 * backup then queries D1, no longer sees the row, copies nothing, and exits
 * green — so the bytes the backup exists to insure are gone with no copy
 * anywhere, and nothing distinguishes that run from a quiet one.
 *
 * So a photo is only deleted once both of its keys are already present in the
 * backup bucket. A late backup now delays a deletion by a night instead of
 * losing the bytes, which is the trade this sweep should have been making all
 * along: an orphan photo costs storage, and a deleted un-backed-up one costs
 * a keepsake.
 *
 * **When the binding is absent this returns `true` and the sweep proceeds.**
 * That is deliberate and it is the important half. `keepsake-photos-
 * production-backup` does not exist yet (#157, blocked on a credential), so a
 * guard that refused every deletion without it would convert one missing
 * bucket into unbounded R2 growth and a `photos` table nothing ever prunes —
 * a worse failure, and a silent one. Instead the skip is loud on a deployed
 * Worker, the same `isDeployed` gate #123 introduced for the cache purge that
 * is *expected* to be unconfigured locally and in tests.
 *
 * `head()`, never `get()`: this only asks whether the key exists, and the
 * binding is used for nothing else, so a bug here cannot write to or delete
 * from the bucket whose whole value is that nothing deletes from it.
 */
async function isBackedUp(env: Env, row: OrphanPhotoRow): Promise<boolean> {
  const backup = photoBackupBucket(env);
  if (!backup) return true;
  const [full, thumb] = await Promise.all([backup.head(row.r2_key_full), backup.head(row.r2_key_thumb)]);
  return full !== null && thumb !== null;
}

/**
 * Says once per run, on a deployed Worker, that photo deletion is running
 * without the backup guard — rather than once per photo, which would bury it.
 * Silent locally and in tests, where the binding is genuinely expected to be
 * absent.
 */
function warnIfUnguarded(env: Env): void {
  if (photoBackupBucket(env) || !isDeployed(env)) return;
  console.warn(
    "orphanSweep: PHOTO_BACKUP_BUCKET is not bound, so photo deletion is running unguarded — " +
      "a photo deleted before the nightly backup copies it is unrecoverable (#178, #157)",
    { environment: env.ENVIRONMENT },
  );
}

async function sweepOrphanPhotos(env: Env, cutoff: number): Promise<{ deleted: number; deferred: number }> {
  let deleted = 0;
  let deferred = 0;
  // Rows skipped for want of a backup copy stay in the table and would be
  // re-selected by the next batch's identical query, so the loop would spin
  // until MAX_PHOTO_BATCHES. Offsetting past them is what keeps one
  // un-backed-up photo from starving every photo behind it.
  let offset = 0;

  for (let batch = 0; batch < MAX_PHOTO_BATCHES; batch++) {
    const { results: rows } = await env.DB.prepare(
      `SELECT id, r2_key_full, r2_key_thumb FROM photos WHERE listing_id IS NULL AND created_at < ? LIMIT ? OFFSET ?`,
    )
      .bind(cutoff, PHOTO_BATCH_SIZE, offset)
      .all<OrphanPhotoRow>();

    if (rows.length === 0) break;

    const deletable: OrphanPhotoRow[] = [];
    for (const row of rows) {
      if (await isBackedUp(env, row)) {
        deletable.push(row);
      } else {
        deferred += 1;
      }
    }

    for (const row of deletable) {
      await env.BUCKET.delete(row.r2_key_full);
      await env.BUCKET.delete(row.r2_key_thumb);
    }

    if (deletable.length > 0) {
      const placeholders = deletable.map(() => "?").join(",");
      await env.DB.prepare(`DELETE FROM photos WHERE id IN (${placeholders})`)
        .bind(...deletable.map((row) => row.id))
        .run();
      deleted += deletable.length;
    }

    offset += rows.length - deletable.length;
    if (rows.length < PHOTO_BATCH_SIZE) break;
  }

  return { deleted, deferred };
}

async function sweepExpiredRecoveryTokens(env: Env, now: number): Promise<number> {
  const cutoff = now - RECOVERY_TOKEN_GRACE_MS;
  const result = await env.DB.prepare("DELETE FROM recovery_tokens WHERE expires_at < ?").bind(cutoff).run();
  return result.meta.changes ?? 0;
}

async function sweepOldEvents(env: Env, now: number): Promise<{ moderation: number; email: number }> {
  const cutoff = now - EVENT_RETENTION_MS;
  const moderationResult = await env.DB.prepare("DELETE FROM moderation_events WHERE created_at < ?").bind(cutoff).run();
  const emailResult = await env.DB.prepare("DELETE FROM email_events WHERE created_at < ?").bind(cutoff).run();
  return { moderation: moderationResult.meta.changes ?? 0, email: emailResult.meta.changes ?? 0 };
}

/**
 * Deletes the R2 objects behind photos of long-terminal listings, and the
 * `photos` rows with them. The **listing** row stays — its status, moderation
 * reason and event history are the audit trail for why it was rejected or
 * hidden, and that is the part worth keeping.
 *
 * The photo rows go too, rather than being kept as tombstones pointing at
 * bytes that no longer exist, for two reasons. It is what makes this sweep
 * idempotent: with the rows kept, every subsequent nightly run would re-issue
 * a `BUCKET.delete()` for every photo of every listing ever rejected, forever,
 * growing without bound. And a row that claims a photo whose bytes are gone is
 * a lie the serving path would have to special-case — `/i/:id/:variant` would
 * 404 on a photo the API still lists.
 */
async function sweepTerminalListingPhotos(env: Env, cutoff: number): Promise<{ deleted: number; deferred: number }> {
  let deleted = 0;
  let deferred = 0;
  let offset = 0;
  const statusPlaceholders = TERMINAL_STATUSES.map(() => "?").join(",");

  for (let batch = 0; batch < MAX_PHOTO_BATCHES; batch++) {
    const { results: rows } = await env.DB.prepare(
      `SELECT p.id, p.r2_key_full, p.r2_key_thumb
         FROM photos p
         JOIN listings l ON l.id = p.listing_id
        WHERE l.status IN (${statusPlaceholders}) AND l.updated_at < ?
        LIMIT ? OFFSET ?`,
    )
      .bind(...TERMINAL_STATUSES, cutoff, PHOTO_BATCH_SIZE, offset)
      .all<OrphanPhotoRow>();

    if (rows.length === 0) break;

    // Same backup guard as `sweepOrphanPhotos` — issue #178 names this sweep
    // and that one together, and a photo of a rejected listing is exactly the
    // case `tools/backup-photos.mjs`'s header calls the risk it insures
    // against, since a wrong rejection is a keepsake nobody meant to destroy.
    const deletable: OrphanPhotoRow[] = [];
    for (const row of rows) {
      if (await isBackedUp(env, row)) {
        deletable.push(row);
      } else {
        deferred += 1;
      }
    }

    for (const row of deletable) {
      await env.BUCKET.delete(row.r2_key_full);
      await env.BUCKET.delete(row.r2_key_thumb);
      // Issue #22. These listings have been non-public for 30 days, so
      // `images.ts`'s DB-status-gated cache lookup already can't reach
      // whatever's left of any cache entry — this is the same defense in
      // depth as the owner-delete path, not a fix for an active leak here.
      await purgePhotoCache(env, row.id);
    }

    if (deletable.length > 0) {
      const placeholders = deletable.map(() => "?").join(",");
      await env.DB.prepare(`DELETE FROM photos WHERE id IN (${placeholders})`)
        .bind(...deletable.map((row) => row.id))
        .run();
      deleted += deletable.length;
    }

    offset += rows.length - deletable.length;
    if (rows.length < PHOTO_BATCH_SIZE) break;
  }

  return { deleted, deferred };
}

/**
 * Nulls `ip_digest` on `requests` and `reports` rows older than the 48 hours
 * the privacy page promises. See `IP_DIGEST_RETENTION_MS` above for why this
 * is a retention promise rather than a tidy-up, and why nothing is lost by
 * doing it.
 *
 * `ip_digest IS NOT NULL` in both `WHERE` clauses is what keeps this
 * idempotent in the same way every other sweep here is: a second run the same
 * night matches nothing rather than rewriting rows it already cleared, and
 * `meta.changes` stays an honest count of what this run actually erased.
 */
async function sweepExpiredIpDigests(env: Env, cutoff: number): Promise<{ requests: number; reports: number }> {
  const requestsResult = await env.DB.prepare(
    "UPDATE requests SET ip_digest = NULL WHERE ip_digest IS NOT NULL AND created_at < ?",
  )
    .bind(cutoff)
    .run();
  const reportsResult = await env.DB.prepare(
    "UPDATE reports SET ip_digest = NULL WHERE ip_digest IS NOT NULL AND created_at < ?",
  )
    .bind(cutoff)
    .run();
  return { requests: requestsResult.meta.changes ?? 0, reports: reportsResult.meta.changes ?? 0 };
}

/**
 * Deletes `owners` rows that hold nothing and have done nothing for
 * `EMPTY_OWNER_AGE_MS`. "Holds nothing" is checked against every table that
 * references an owner — listings, photos, recovery tokens — plus the email
 * column, so this can only ever remove a row whose deletion is unobservable
 * to anyone. A row with a verified email is a dashboard someone can recover
 * into, so `email IS NULL` is required even when nothing else is attached.
 *
 * `last_seen_at` (not `created_at`) is the clock: `ownerAuth` bumps it at most
 * hourly, so an owner who is still using the app is never a candidate however
 * old their row is.
 */
async function sweepEmptyOwners(env: Env, cutoff: number): Promise<number> {
  const result = await env.DB.prepare(
    `DELETE FROM owners
      WHERE last_seen_at < ?
        AND created_at < ?
        AND email IS NULL
        AND NOT EXISTS (SELECT 1 FROM listings WHERE listings.owner_id = owners.id)
        AND NOT EXISTS (SELECT 1 FROM photos WHERE photos.owner_id = owners.id)
        AND NOT EXISTS (SELECT 1 FROM recovery_tokens WHERE recovery_tokens.owner_id = owners.id)`,
  )
    .bind(cutoff, cutoff)
    .run();
  return result.meta.changes ?? 0;
}

export async function orphanSweep(env: Env): Promise<void> {
  const now = Date.now();

  warnIfUnguarded(env);

  const orphanPhotos = await sweepOrphanPhotos(env, now - ORPHAN_PHOTO_AGE_MS);
  const terminalPhotos = await sweepTerminalListingPhotos(env, now - TERMINAL_PHOTO_RETENTION_MS);
  const photosDeleted = orphanPhotos.deleted;
  const terminalPhotosDeleted = terminalPhotos.deleted;
  const photosDeferred = orphanPhotos.deferred + terminalPhotos.deferred;
  const tokensDeleted = await sweepExpiredRecoveryTokens(env, now);
  const { moderation: moderationDeleted, email: emailDeleted } = await sweepOldEvents(env, now);
  const { requests: requestDigestsCleared, reports: reportDigestsCleared } = await sweepExpiredIpDigests(
    env,
    now - IP_DIGEST_RETENTION_MS,
  );
  // Last, and after `sweepOrphanPhotos` specifically: that sweep is what
  // removes the only thing an abandoned give-flow owner ever held, so running
  // it first means the same night collects the owner too instead of leaving
  // it for tomorrow. An owner whose *listing* was rejected is never collected
  // — the listing row survives (finding 15 keeps it deliberately), and
  // `NOT EXISTS (… FROM listings …)` sees it.
  const ownersDeleted = await sweepEmptyOwners(env, now - EMPTY_OWNER_AGE_MS);

  if (photosDeferred > 0) {
    console.warn("orphanSweep: photo deletions deferred, waiting on the backup bucket", {
      photosDeferred,
      environment: env.ENVIRONMENT,
    });
  }

  console.log("orphanSweep: done", {
    environment: env.ENVIRONMENT,
    photosDeleted,
    terminalPhotosDeleted,
    // #178: how many photos this run refused to delete because the backup
    // bucket did not have them yet. A non-zero count on one night is the
    // guard working; a non-zero count every night means the backup workflow
    // has stopped, which is a thing to notice rather than to infer from R2
    // growth.
    photosDeferred,
    tokensDeleted,
    moderationDeleted,
    emailDeleted,
    requestDigestsCleared,
    reportDigestsCleared,
    ownersDeleted,
  });

  // No heartbeat write here any more (#165): `runCron` in `index.ts` writes
  // `cron:last:orphanSweep` for every registered job the moment this
  // resolves, so a stalled cron trigger is still visible from the admin page
  // rather than inferred from a growing orphan-photo count in R2 storage
  // bills — it is just no longer this file's job to remember.
}

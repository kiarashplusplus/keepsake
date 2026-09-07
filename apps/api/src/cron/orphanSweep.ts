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
 *
 * Every condition is purely time-based, so re-running this twice in a row
 * (a retried cron invocation, a manual trigger) is a no-op the second time:
 * nothing already deleted can match the same `WHERE` clause again.
 */
import type { Env } from "../env.js";
import { purgePhotoCache } from "../lib/photoCache.js";

const ORPHAN_PHOTO_AGE_MS = 24 * 60 * 60 * 1000;
const RECOVERY_TOKEN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

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

async function sweepOrphanPhotos(env: Env, cutoff: number): Promise<number> {
  let deleted = 0;

  for (let batch = 0; batch < MAX_PHOTO_BATCHES; batch++) {
    const { results: rows } = await env.DB.prepare(
      `SELECT id, r2_key_full, r2_key_thumb FROM photos WHERE listing_id IS NULL AND created_at < ? LIMIT ?`,
    )
      .bind(cutoff, PHOTO_BATCH_SIZE)
      .all<OrphanPhotoRow>();

    if (rows.length === 0) break;

    for (const row of rows) {
      await env.BUCKET.delete(row.r2_key_full);
      await env.BUCKET.delete(row.r2_key_thumb);
    }

    const placeholders = rows.map(() => "?").join(",");
    await env.DB.prepare(`DELETE FROM photos WHERE id IN (${placeholders})`)
      .bind(...rows.map((row) => row.id))
      .run();

    deleted += rows.length;
    if (rows.length < PHOTO_BATCH_SIZE) break;
  }

  return deleted;
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
async function sweepTerminalListingPhotos(env: Env, cutoff: number): Promise<number> {
  let deleted = 0;
  const statusPlaceholders = TERMINAL_STATUSES.map(() => "?").join(",");

  for (let batch = 0; batch < MAX_PHOTO_BATCHES; batch++) {
    const { results: rows } = await env.DB.prepare(
      `SELECT p.id, p.r2_key_full, p.r2_key_thumb
         FROM photos p
         JOIN listings l ON l.id = p.listing_id
        WHERE l.status IN (${statusPlaceholders}) AND l.updated_at < ?
        LIMIT ?`,
    )
      .bind(...TERMINAL_STATUSES, cutoff, PHOTO_BATCH_SIZE)
      .all<OrphanPhotoRow>();

    if (rows.length === 0) break;

    for (const row of rows) {
      await env.BUCKET.delete(row.r2_key_full);
      await env.BUCKET.delete(row.r2_key_thumb);
      // Issue #22. These listings have been non-public for 30 days, so
      // `images.ts`'s DB-status-gated cache lookup already can't reach
      // whatever's left of any cache entry — this is the same defense in
      // depth as the owner-delete path, not a fix for an active leak here.
      await purgePhotoCache(env, row.id);
    }

    const placeholders = rows.map(() => "?").join(",");
    await env.DB.prepare(`DELETE FROM photos WHERE id IN (${placeholders})`)
      .bind(...rows.map((row) => row.id))
      .run();

    deleted += rows.length;
    if (rows.length < PHOTO_BATCH_SIZE) break;
  }

  return deleted;
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

  const photosDeleted = await sweepOrphanPhotos(env, now - ORPHAN_PHOTO_AGE_MS);
  const terminalPhotosDeleted = await sweepTerminalListingPhotos(env, now - TERMINAL_PHOTO_RETENTION_MS);
  const tokensDeleted = await sweepExpiredRecoveryTokens(env, now);
  const { moderation: moderationDeleted, email: emailDeleted } = await sweepOldEvents(env, now);
  // Last, and after `sweepOrphanPhotos` specifically: that sweep is what
  // removes the only thing an abandoned give-flow owner ever held, so running
  // it first means the same night collects the owner too instead of leaving
  // it for tomorrow. An owner whose *listing* was rejected is never collected
  // — the listing row survives (finding 15 keeps it deliberately), and
  // `NOT EXISTS (… FROM listings …)` sees it.
  const ownersDeleted = await sweepEmptyOwners(env, now - EMPTY_OWNER_AGE_MS);

  console.log("orphanSweep: done", {
    environment: env.ENVIRONMENT,
    photosDeleted,
    terminalPhotosDeleted,
    tokensDeleted,
    moderationDeleted,
    emailDeleted,
    ownersDeleted,
  });

  // No heartbeat write here any more (#165): `runCron` in `index.ts` writes
  // `cron:last:orphanSweep` for every registered job the moment this
  // resolves, so a stalled cron trigger is still visible from the admin page
  // rather than inferred from a growing orphan-photo count in R2 storage
  // bills — it is just no longer this file's job to remember.
}

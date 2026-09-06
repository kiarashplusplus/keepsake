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
 *
 * Every condition is purely time-based, so re-running this twice in a row
 * (a retried cron invocation, a manual trigger) is a no-op the second time:
 * nothing already deleted can match the same `WHERE` clause again.
 */
import type { Env } from "../env.js";

const ORPHAN_PHOTO_AGE_MS = 24 * 60 * 60 * 1000;
const RECOVERY_TOKEN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

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

export async function orphanSweep(env: Env): Promise<void> {
  const now = Date.now();

  const photosDeleted = await sweepOrphanPhotos(env, now - ORPHAN_PHOTO_AGE_MS);
  const tokensDeleted = await sweepExpiredRecoveryTokens(env, now);
  const { moderation: moderationDeleted, email: emailDeleted } = await sweepOldEvents(env, now);

  console.log("orphanSweep: done", {
    environment: env.ENVIRONMENT,
    photosDeleted,
    tokensDeleted,
    moderationDeleted,
    emailDeleted,
  });

  // Read by `GET /api/admin/health` (`cron:last:<name>`) so a stalled cron
  // trigger is visible from the admin page, not just inferred from a growing
  // orphan-photo count in R2 storage bills.
  await env.KV.put("cron:last:orphanSweep", String(now));
}

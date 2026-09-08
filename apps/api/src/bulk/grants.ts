/**
 * Admission: minting a `bulk_grants` row and the exact, D1-guarded counters
 * that bound what one grant — and the owner behind it — may spend in a day.
 *
 * These are never KV. `moderation/budget.ts`'s own header says the KV
 * calendar-day counters are "eventually consistent by [their] own
 * documentation" — fine for a soft per-IP brake with no account behind it,
 * wrong for admission that a giver is relying on to finish an estate. A
 * grant is per-owner, so a real D1 guarded UPDATE is both available and
 * correct here in a way it isn't for an anonymous IP.
 *
 * `mintGrant`/`loadUsableGrant`/`bindGrantToBatch` are ordinary awaited
 * queries — nothing here needs a transaction on its own. The two
 * `build*DebitStatements` functions are different: they return *unexecuted*
 * `D1PreparedStatement`s so a caller (`routes/bulk.ts`) can run a debit in
 * the exact same `env.DB.batch()` as the insert it pays for. That is the
 * whole point — a debit that lands in its own separate `.run()` either
 * charges for work that a sibling statement's guard just refused, or (the
 * opposite mistake) never gets refunded when that guard fires. One
 * transaction makes "the write happened" and "the write was paid for" the
 * same fact.
 */
import type { Env } from "../env.js";
import type { BulkGrantSummary } from "@keepsake/contracts/bulk";
import { ulid } from "../lib/ids.js";
import { bulkGrantTtlHours } from "../env.js";

export interface BulkGrantRow {
  id: string;
  owner_id: string;
  batch_id: string | null;
  items_remaining: number;
  photos_remaining: number;
  issued_by: string;
  expires_at: number;
  revoked_at: number | null;
  created_at: number;
}

const GRANT_COLUMNS =
  "id, owner_id, batch_id, items_remaining, photos_remaining, issued_by, expires_at, revoked_at, created_at";

export interface MintGrantOptions {
  ownerId: string;
  items: number;
  photos: number;
  now?: number;
}

/** `POST /api/admin/bulk/grants` — an operator minting admission for one
 * owner's pilot estate. `issued_by = 'admin'` always: the 'renew' kind the
 * migration's comment describes (resets only `expires_at`, never the two
 * counters) has no route yet and is not part of this task. */
export async function mintGrant(env: Env, options: MintGrantOptions): Promise<BulkGrantRow> {
  const now = options.now ?? Date.now();
  const id = ulid(now);
  const expiresAt = now + bulkGrantTtlHours(env) * 3_600_000;

  await env.DB.prepare(
    `INSERT INTO bulk_grants (id, owner_id, batch_id, items_remaining, photos_remaining, issued_by, expires_at, created_at)
     VALUES (?, ?, NULL, ?, ?, 'admin', ?, ?)`,
  )
    .bind(id, options.ownerId, options.items, options.photos, expiresAt, now)
    .run();

  return {
    id,
    owner_id: options.ownerId,
    batch_id: null,
    items_remaining: options.items,
    photos_remaining: options.photos,
    issued_by: "admin",
    expires_at: expiresAt,
    revoked_at: null,
    created_at: now,
  };
}

export interface LoadUsableGrantOptions {
  grantId: string;
  ownerId: string;
  now: number;
}

/**
 * The row if it exists, belongs to this owner, is not revoked and not
 * expired — else `null`. Scoped by `owner_id` in the query itself (not
 * checked afterward in application code) for the same reason
 * `findBatchById` in `./batches.js` is: a caller naming *someone else's*
 * grant id must get exactly the same answer as a caller naming a grant that
 * doesn't exist at all.
 */
export async function loadUsableGrant(env: Env, options: LoadUsableGrantOptions): Promise<BulkGrantRow | null> {
  const row = await env.DB.prepare(
    `SELECT ${GRANT_COLUMNS} FROM bulk_grants
      WHERE id = ? AND owner_id = ? AND revoked_at IS NULL AND expires_at > ?`,
  )
    .bind(options.grantId, options.ownerId, options.now)
    .first<BulkGrantRow>();
  return row ?? null;
}

/**
 * Binds a grant to the one batch it will ever be spent against, on first
 * use only. `WHERE batch_id IS NULL` is the whole mechanism: a grant already
 * bound to a batch is untouched by a second call (a retried `POST /batches`,
 * or a grant reused across an owner's other batches), so "bound to one
 * batch for the rest of its life" (the migration's own words) stays true no
 * matter how many times this runs.
 */
export async function bindGrantToBatch(env: Env, grantId: string, batchId: string): Promise<void> {
  await env.DB.prepare(`UPDATE bulk_grants SET batch_id = ? WHERE id = ? AND batch_id IS NULL`).bind(batchId, grantId).run();
}

export interface DebitStatements {
  statements: D1PreparedStatement[];
  /** Index into a `env.DB.batch(...)` result array for the grant-side
   * debit's own statement. `meta.changes === 0` means the grant had nothing
   * left (or was revoked/expired between `requireGrant()` and this write) —
   * refuse, don't charge. */
  grantResultIndex: number;
  /** Index for the owner/day ceiling's debit. `meta.changes === 0` means
   * this owner already spent today's allowance — refuse, don't charge. The
   * `ON CONFLICT ... DO UPDATE ... WHERE` guard is what makes a first-ever
   * row for today and the 151st item today refuse identically: SQLite runs
   * the upsert's `WHERE` against the row *after* the insert-or-update values
   * would apply, so a fresh row can never dodge the ceiling by skipping the
   * `UPDATE` branch. */
  usageResultIndex: number;
}

export interface ItemDebitOptions {
  grant: BulkGrantRow;
  ownerId: string;
  day: string;
  limit: number;
  now?: number;
}

/**
 * The item half of admission. Two statements, meant to run inside the same
 * `env.DB.batch()` as the item insert they pay for:
 *
 *  1. `bulk_grants.items_remaining -= 1`, guarded on `> 0` and on the grant
 *     still being live — a grant revoked mid-batch stops spending the
 *     instant the revoke lands, not at the next full reload.
 *  2. `bulk_owner_usage` upsert for `day` (from `lib/day.ts`'s `todayISO()`,
 *     so this ceiling rolls over at the same UTC midnight the KV budgets
 *     do), guarded so the running total can never cross `limit` — the per
 *     owner per day ceiling that survives a new batch or a renewed grant,
 *     per the migration's own comment on why this table exists at all.
 */
export function buildItemDebitStatements(env: Env, options: ItemDebitOptions): DebitStatements {
  const now = options.now ?? Date.now();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE bulk_grants SET items_remaining = items_remaining - 1
        WHERE id = ? AND items_remaining > 0 AND revoked_at IS NULL AND expires_at > ?`,
    ).bind(options.grant.id, now),
    env.DB.prepare(
      `INSERT INTO bulk_owner_usage (owner_id, day, items_used) VALUES (?, ?, 1)
         ON CONFLICT(owner_id, day) DO UPDATE SET items_used = items_used + 1 WHERE items_used < ?`,
    ).bind(options.ownerId, options.day, options.limit),
  ];
  return { statements, grantResultIndex: 0, usageResultIndex: 1 };
}

export interface PhotoDebitOptions {
  grant: BulkGrantRow;
  ownerId: string;
  day: string;
  limit: number;
  now?: number;
}

/** The photo half of admission — same shape as {@link buildItemDebitStatements},
 * against `photos_remaining`/`bulk_owner_usage.photos_used`. */
export function buildPhotoDebitStatements(env: Env, options: PhotoDebitOptions): DebitStatements {
  const now = options.now ?? Date.now();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE bulk_grants SET photos_remaining = photos_remaining - 1
        WHERE id = ? AND photos_remaining > 0 AND revoked_at IS NULL AND expires_at > ?`,
    ).bind(options.grant.id, now),
    env.DB.prepare(
      `INSERT INTO bulk_owner_usage (owner_id, day, photos_used) VALUES (?, ?, 1)
         ON CONFLICT(owner_id, day) DO UPDATE SET photos_used = photos_used + 1 WHERE photos_used < ?`,
    ).bind(options.ownerId, options.day, options.limit),
  ];
  return { statements, grantResultIndex: 0, usageResultIndex: 1 };
}

export interface SettleDebitOptions {
  grantId: string;
  ownerId: string;
  day: string;
  kind: "items" | "photos";
  /** Whether the grant-side statement (from {@link buildItemDebitStatements}
   * or {@link buildPhotoDebitStatements}) actually decremented a row —
   * `results[debit.grantResultIndex].meta.changes > 0`, read by the caller
   * out of whichever `env.DB.batch()` call it ran in. */
  grantOk: boolean;
  /** Same, for the owner/day usage statement. */
  usageOk: boolean;
}

/**
 * The other half of "the debit must be in the same `DB.batch()` as the
 * insert it pays for": *within* that one batch call, the grant-side
 * statement and the owner/day statement are each guarded independently, so
 * it is entirely possible for exactly one of them to succeed — a grant with
 * one item left, for an owner who already spent today's ceiling, decrements
 * `items_remaining` and *then* the usage upsert's `WHERE items_used < ?`
 * refuses. Both statements already ran by the time the caller can look at
 * either result, so "refuse the write" is not enough on its own — the
 * grant's successful decrement is real and permanent unless something
 * undoes it. This is that something: exactly one compensating write when
 * exactly one side succeeded, none when they agree.
 *
 * Deliberately a follow-up statement rather than folded into the original
 * `DB.batch()` — it only needs to exist in the rare case the two disagree,
 * and reading `meta.changes` first is what tells us whether it is needed at
 * all.
 */
export async function settleDebit(env: Env, options: SettleDebitOptions): Promise<boolean> {
  const { grantOk, usageOk } = options;
  if (grantOk === usageOk) return grantOk;

  const grantColumn = options.kind === "items" ? "items_remaining" : "photos_remaining";
  const usageColumn = options.kind === "items" ? "items_used" : "photos_used";

  if (grantOk) {
    // The grant charged; the owner/day ceiling refused. Refund the grant.
    await env.DB.prepare(`UPDATE bulk_grants SET ${grantColumn} = ${grantColumn} + 1 WHERE id = ?`).bind(options.grantId).run();
  } else {
    // The owner/day ceiling charged; the grant refused. Refund the usage row.
    await env.DB.prepare(`UPDATE bulk_owner_usage SET ${usageColumn} = ${usageColumn} - 1 WHERE owner_id = ? AND day = ?`)
      .bind(options.ownerId, options.day)
      .run();
  }
  return false;
}

/** `BulkGrantSummary` never includes the owner id — the id is not a secret,
 * see `BULK_GRANT_HEADER`'s own comment, but the owner it is bound to is the
 * one thing that *would* leak something if this were ever handed to a
 * stranger. Kept as its own function rather than inlined at the one call
 * site (`routes/admin.ts`) so a second grant-returning route can't drift. */
export function serializeBulkGrant(grant: BulkGrantRow): BulkGrantSummary {
  return {
    id: grant.id,
    batch_id: grant.batch_id,
    items_remaining: grant.items_remaining,
    photos_remaining: grant.photos_remaining,
    expires_at: grant.expires_at,
  };
}

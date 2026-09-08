/**
 * What bounds an estate batch: one row per owner per day in
 * `bulk_owner_usage`, spent by exact, D1-guarded upserts.
 *
 * These are never KV. `moderation/budget.ts`'s own header says the KV
 * calendar-day counters are "eventually consistent by [their] own
 * documentation" — fine for a soft per-IP brake with no account behind it,
 * wrong for a ceiling a giver is relying on to finish an estate. Bulk
 * writes carry an owner token, so a real D1 guarded UPDATE is both
 * available and correct here in a way it isn't for an anonymous IP.
 *
 * There used to be a second, per-batch allowance above this — an
 * operator-minted `bulk_grants` row whose id a giver pasted in as an
 * "admission code". It is gone: the code was a step between a giver and
 * their own keepsakes that only an operator could unblock, and nothing it
 * bounded is unbounded now. Per-batch volume is capped at write time by
 * `BULK_MAX_ITEMS_PER_BATCH`/`BULK_MAX_PHOTOS_PER_BATCH` (see
 * `routes/bulk.ts`, where the cap is a predicate on the insert itself), and
 * total volume by these per-owner-per-day counters, which survive a giver
 * starting a second batch — the property the grant never had.
 *
 * Each debit is a *single* statement, returned unexecuted so a caller
 * (`routes/bulk.ts`) can run it in the exact same `env.DB.batch()` as the
 * insert it pays for. That is the whole point — a debit that lands in its
 * own separate `.run()` either charges for work that a sibling statement's
 * guard just refused, or (the opposite mistake) never gets refunded when
 * that guard fires. One transaction makes "the write happened" and "the
 * write was paid for" the same fact. One statement is also why there is no
 * compensation logic here: the old two-statement shape needed
 * reconciling when its two independently-guarded halves disagreed, and a
 * single guard has nothing to disagree with.
 */
import type { Env } from "../env.js";

/** The `bulk_owner_usage` counter a write is charged against. */
export type UsageKind = "items" | "photos" | "suggestions";

const USAGE_COLUMNS: Record<UsageKind, string> = {
  items: "items_used",
  photos: "photos_used",
  suggestions: "suggestions_used",
};

export interface UsageDebitOptions {
  kind: UsageKind;
  ownerId: string;
  /** From `lib/day.ts`'s `todayISO()`, so this ceiling rolls over at the
   * same UTC midnight the KV budgets do. */
  day: string;
  limit: number;
}

/**
 * One guarded upsert for `day`, so the running total can never cross
 * `limit`. **Both** branches carry the ceiling, and that is the whole
 * subtlety: `ON CONFLICT ... DO UPDATE ... WHERE` guards only the *update*,
 * so the `INSERT` half — an owner's first write of the day — used to land
 * unconditionally. The old comment here claimed otherwise ("SQLite runs the
 * upsert's `WHERE` against the row after the insert-or-update values would
 * apply, so a fresh row can never dodge the ceiling"), which is simply not
 * how the clause works.
 *
 * It never showed, because the grant that sat below this ran its own
 * `> 0`-guarded `UPDATE` in the same transaction and refused first. Removing
 * the grant removed the thing that was covering for it: with a ceiling of 0,
 * a fresh owner's first photo was admitted, and `test/bulkCeilings.ts`'s
 * exhausted-allowance case is what caught it. Hence `SELECT ... WHERE ? > 0`
 * for the insert branch — a ceiling of zero admits nothing, on any day, for
 * any owner.
 *
 * `meta.changes === 0` on this statement means this owner already spent
 * today's allowance — refuse, don't charge.
 */
export function buildUsageDebitStatement(env: Env, options: UsageDebitOptions): D1PreparedStatement {
  const column = USAGE_COLUMNS[options.kind];
  return env.DB.prepare(
    `INSERT INTO bulk_owner_usage (owner_id, day, ${column})
     SELECT ?, ?, 1 WHERE ? > 0
       ON CONFLICT(owner_id, day) DO UPDATE SET ${column} = ${column} + 1 WHERE ${column} < ?`,
  ).bind(options.ownerId, options.day, options.limit, options.limit);
}

/**
 * The compensating write for a debit whose paired insert then refused —
 * used only where the insert cannot be made a precondition of the debit in
 * the same transaction. Callers that *can* guard the insert (every one in
 * `routes/bulk.ts` today) should do that instead: an unspent debit is
 * better than a refunded one.
 */
export async function refundUsage(env: Env, options: { kind: UsageKind; ownerId: string; day: string }): Promise<void> {
  const column = USAGE_COLUMNS[options.kind];
  await env.DB.prepare(`UPDATE bulk_owner_usage SET ${column} = ${column} - 1 WHERE owner_id = ? AND day = ?`)
    .bind(options.ownerId, options.day)
    .run();
}

/** Calendar day in UTC, `YYYY-MM-DD`. Used everywhere a digest needs to
 * rotate daily (reports' `ip_digest`, `src/moderation/budget.ts`'s KV keys)
 * so the same address hashes to something unrelated tomorrow — two days of
 * digests can't be joined into a history of one caller. Duplicated here
 * rather than imported from `budget.ts` (which keeps its own private copy)
 * because that file predates this one and re-exporting across the two would
 * be a change to M1-owned code for no behavioral gain. */
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

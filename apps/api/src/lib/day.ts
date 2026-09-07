/** Calendar day in UTC, `YYYY-MM-DD`. Used everywhere a digest needs to
 * rotate daily (`lib/digest.ts`'s `dailyIpDigest`, and through it reports'
 * `ip_digest`, the `burst()` limiter key and `src/moderation/budget.ts`'s KV
 * keys) so the same address hashes to something unrelated tomorrow — two
 * days of digests can't be joined into a history of one caller.
 *
 * `budget.ts` used to keep a second, private copy of this function and an
 * earlier version of this comment explained why that was tolerable. It isn't
 * any more (issue #87): the day is now the thing that makes the privacy
 * page's "combined with the date" claim true of *every* path, so there is
 * exactly one definition of what "the day" means and `budget.ts` re-exports
 * this one. */
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

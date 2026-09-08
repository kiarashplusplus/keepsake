/**
 * Turning a listing's `staleness` block into the sentences the dashboard
 * shows, and answering the one owner-level question the list view asks of a
 * whole page of listings ("is the giver reachable at all?").
 *
 * Pure and React-free, like `groupListings.ts` next door and for the same
 * reason: the copy a giver reads when a stranger has been left waiting is
 * worth pinning in a unit test, and a test should not have to render a screen
 * to read it.
 */
import { LISTING_STALE_MESSAGES, type ListingStaleness } from "@keepsake/contracts/listing";

/** The two reasons that are really about the owner's mailbox rather than
 * about one keepsake. Narrower than `ListingStaleReason` on purpose: it is
 * what `OWNER_EMAIL_PROBLEM_COPY` below can speak to, so a third email-shaped
 * reason added later fails to compile here rather than rendering blank copy. */
export type OwnerEmailProblem = "email_missing" | "email_unverified";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/**
 * How long someone has been waiting, in whole units, always grammatical.
 *
 * `lib/relativeTime.ts` is the wrong tool here even though it is right
 * everywhere else: past a week it falls back to an absolute date, which reads
 * fine as a timestamp ("posted Sep 1, 2026") and badly inside a sentence about
 * duration. The staleness threshold is 72 hours, so this never has to describe
 * anything shorter than three days.
 */
export function waitedFor(elapsedMs: number): string {
  const days = Math.max(1, Math.floor(elapsedMs / DAY_MS));
  if (days < 14) return days === 1 ? "a day" : `${days} days`;

  const weeks = Math.floor(elapsedMs / WEEK_MS);
  if (weeks < 9) return `${weeks} weeks`;

  const months = Math.max(2, Math.floor(days / 30));
  return `${months} months`;
}

/**
 * One line per reason, most human cost first (the API orders `reasons`; this
 * preserves that order rather than re-deciding it).
 *
 * The unanswered-ask line is built here instead of coming from
 * `LISTING_STALE_MESSAGES` because it is the one that carries a number, and
 * the number is the point — "someone asked" is a fact about the listing,
 * "someone has been waiting eleven days" is the thing that makes a person
 * open it.
 */
export function staleLines(staleness: ListingStaleness, now: number = Date.now()): string[] {
  return staleness.reasons.map((reason) => {
    if (reason === "requests_unanswered" && staleness.waiting_since !== null) {
      return `Someone has been waiting ${waitedFor(now - staleness.waiting_since)} to hear back.`;
    }
    return LISTING_STALE_MESSAGES[reason];
  });
}

/** The shortest true thing that fits on a list row — the first reason only,
 * since the row has one line and the reasons are already in priority order. */
export function staleSummary(staleness: ListingStaleness, now: number = Date.now()): string | null {
  return staleLines(staleness, now)[0] ?? null;
}

const EMAIL_REASONS: readonly OwnerEmailProblem[] = ["email_missing", "email_unverified"];

/**
 * The owner-level half of staleness, read off the listings themselves.
 *
 * "No reachable address" is a fact about the giver's mailbox, not about any
 * one keepsake, so repeating it on six rows would be six copies of one
 * problem with one fix. The list view lifts it into a single banner instead,
 * and derives it from the listings rather than a second `GET /api/me` call so
 * the banner and the rows can never disagree about the same account.
 *
 * `null` when no live listing is affected — including when the giver has no
 * live listings at all, where an address is not yet load-bearing.
 */
export function ownerEmailProblem(listings: readonly { staleness: ListingStaleness }[]): OwnerEmailProblem | null {
  for (const reason of EMAIL_REASONS) {
    if (listings.some((listing) => listing.staleness.reasons.includes(reason))) return reason;
  }
  return null;
}

/** Banner copy for `ownerEmailProblem`'s two cases: what is true now, and
 * what the button next to it will do about it. */
export const OWNER_EMAIL_PROBLEM_COPY: Record<OwnerEmailProblem, { title: string; line: string; action: string }> = {
  email_missing: {
    title: "Nobody can reach you",
    line: "Your keepsakes are live, but there's no email on this device — so when someone asks, we have no way to tell you, and no way back to these if you lose this browser.",
    action: "Add an email",
  },
  email_unverified: {
    title: "One tap left",
    line: "Your email isn't verified yet, so we still can't send you asks. Check your inbox for the link — or send yourself a new one.",
    action: "Verify email",
  },
};

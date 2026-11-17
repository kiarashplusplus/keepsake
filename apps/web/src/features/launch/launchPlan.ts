/**
 * The November 2026 launch, as data and pure decisions — no React, no DOM.
 *
 * Keepsake's public launch is Friday 27 November 2026 (the day after
 * Thanksgiving) and the first in-person meetup is Saturday 28 November.
 * `LaunchModal` puts a celebratory dialog in front of the site for both;
 * everything it needs to decide — which message, whether this device has
 * already seen it, whether this route should be left alone — lives here so
 * it can be tested without a browser.
 *
 * Dates are the VISITOR'S calendar dates, not UTC instants: "Friday the 27th"
 * means their Friday. A visitor in Auckland gets the "we're live" message a
 * few hours before one in Houston, which is the honest reading of a date
 * with no time on it.
 *
 * This whole feature expires on its own: from 29 November the phase is
 * `over` and nothing renders. Delete `features/launch/` after that.
 */

/** Year, month (1-12), day. */
const LAUNCH = { year: 2026, month: 11, day: 27 } as const;
const MEETUP = { year: 2026, month: 11, day: 28 } as const;

export const LAUNCH_DATE_LABEL = "Friday, November 27";
export const MEETUP_DATE_LABEL = "Saturday, November 28";

/**
 * The Meetup event page. `null` until the event is posted — the modal then
 * says the RSVP link is coming instead of rendering a button that goes
 * nowhere. Paste the event URL here once it exists
 * (`docs/launch/meetup-posting.md` has the posting itself).
 */
export const MEETUP_URL: string | null = null;

/**
 * `countdown` — before launch day. `live` — launch day and meetup day.
 * `over` — after the meetup; the modal never shows again.
 */
export type LaunchPhase = "countdown" | "live" | "over";

/** A calendar date as one comparable number, in the clock's own time zone. */
function dayNumber(year: number, month: number, day: number): number {
  return year * 10000 + month * 100 + day;
}

function localDayNumber(now: Date): number {
  return dayNumber(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

export function launchPhase(now: Date): LaunchPhase {
  const today = localDayNumber(now);
  if (today < dayNumber(LAUNCH.year, LAUNCH.month, LAUNCH.day)) return "countdown";
  if (today <= dayNumber(MEETUP.year, MEETUP.month, MEETUP.day)) return "live";
  return "over";
}

/** Whole calendar days from the visitor's today to launch day; 0 on or after it. */
export function daysUntilLaunch(now: Date): number {
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const launch = Date.UTC(LAUNCH.year, LAUNCH.month - 1, LAUNCH.day);
  return Math.max(0, Math.round((launch - today) / 86_400_000));
}

/** "10 days to go", "Tomorrow", … — the line under the stamp while counting down. */
export function countdownLabel(now: Date): string {
  const days = daysUntilLaunch(now);
  if (days <= 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `${days} days to go`;
}

/**
 * Which phase this device last dismissed the modal in.
 *
 * It stores the phase rather than a bare flag so the modal comes back ONCE
 * on launch day for someone who waved away the countdown: "it's coming" and
 * "it's here" are two different pieces of news. Dismissing `live` covers
 * both.
 */
export const LAUNCH_DISMISSED_KEY = "keepsake.launch.2026-11.dismissed.v1";

const PHASE_RANK: Record<LaunchPhase, number> = { countdown: 1, live: 2, over: 3 };

export function isDismissed(stored: string | null, phase: LaunchPhase): boolean {
  if (stored !== "countdown" && stored !== "live") return false;
  return PHASE_RANK[stored] >= PHASE_RANK[phase];
}

/**
 * Routes the modal stays off. Each is somewhere a person lands from a link
 * in an email to do one specific thing — confirm an address, unsubscribe,
 * withdraw a request, recover a device — or is the operator's own console.
 * Confetti over an unsubscribe page is a dark pattern, however festive.
 */
const QUIET_PREFIXES = ["/admin", "/confirm", "/unsubscribe", "/withdraw", "/recover"] as const;

export function isQuietPath(pathname: string): boolean {
  return QUIET_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** The one question `LaunchModal` asks on mount. */
export function shouldShowLaunch(input: { now: Date; pathname: string; stored: string | null }): boolean {
  const phase = launchPhase(input.now);
  if (phase === "over") return false;
  if (isQuietPath(input.pathname)) return false;
  return !isDismissed(input.stored, phase);
}

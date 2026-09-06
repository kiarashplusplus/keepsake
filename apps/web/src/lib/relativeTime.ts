/**
 * Short relative-time strings for feed/item/dashboard timestamps ("posted
 * 3 h ago", a request's "2 d ago"). Deliberately terse (single-letter units)
 * rather than `Intl.RelativeTimeFormat`'s "3 hours ago" — matches the
 * caption-scale copy these strings render in.
 */
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

export function relativeTime(fromMs: number, nowMs: number = Date.now()): string {
  const deltaMs = Math.max(0, nowMs - fromMs);

  if (deltaMs < MINUTE_MS) return "just now";
  if (deltaMs < HOUR_MS) return `${Math.floor(deltaMs / MINUTE_MS)} min ago`;
  if (deltaMs < DAY_MS) return `${Math.floor(deltaMs / HOUR_MS)} h ago`;
  if (deltaMs < WEEK_MS) return `${Math.floor(deltaMs / DAY_MS)} d ago`;

  return new Date(fromMs).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

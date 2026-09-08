/**
 * What is currently narrowing the feed, and what to say when that leaves
 * nothing on the table.
 *
 * Issue #220: the feed had one empty state — "Nothing here yet. Be the first
 * to give something." with a `Give something` button — and showed it for
 * every reason a page could come back with zero items. Typing a word that
 * matches none of six live listings therefore told the visitor the
 * marketplace was dead, and offered them the single action that cannot
 * possibly help: posting a keepsake does not find the one you were looking
 * for. The three reasons are genuinely different situations, they want
 * different sentences, and only the first one had ever been written:
 *
 *   `catalogue` — nothing is filtered and the feed is still empty. The
 *                 marketplace really is bare; the invitation is right.
 *   `filtered`  — a search word and/or a category is on. Name what was
 *                 asked for, and offer to take the filters off.
 *   `radius`    — no text, no category, but a postcode/coordinates plus a
 *                 radius. Offer to widen it.
 *
 * Kept pure and separate from `app/index.tsx` (the same split
 * `buildFeedQuery.ts` makes, and for the same reason) so the resolution can
 * be unit-tested without rendering a screen and without a mocked feed
 * fetch — see `test/features/feed/emptyState.test.ts`.
 *
 * `describeLocationChoice` lives here rather than in `LocationBar.tsx`
 * because the feed's narrow-width location disclosure (issue #219) has to
 * summarise the visitor's choice in its collapsed state using *exactly* the
 * same rule these sentences use. Two formatters would eventually disagree,
 * and a summary that says "25 mi of 02144" over an empty state that says
 * the radius is not the problem is worse than either alone.
 */
import { RADIUS_OPTIONS } from "@keepsake/contracts/feed";
import { CATEGORY_LABELS, type Category } from "@keepsake/contracts/listing";
import type { LocationPref, RadiusChoice } from "@/lib/geo";

/**
 * Whether the radius is actually cutting the result set down.
 *
 * This deliberately mirrors `buildFeedQuery`'s geo branch condition rather
 * than testing `location.radius !== "anywhere"` on its own: a radius with no
 * postcode and no coordinates behind it is never sent to the API, so a "25
 * mi" chip sitting selected next to an empty postcode field narrows exactly
 * nothing. Offering to widen it would be a button that changes state and
 * changes no results — the failure mode #220 is about. If `buildFeedQuery`'s
 * rule ever moves, this has to move with it.
 */
export function radiusIsActive(location: LocationPref): boolean {
  if (location.radius === "anywhere") return false;
  if (location.mode === "coords") return location.lat !== null && location.lng !== null;
  if (location.mode === "postal") return location.postal.trim() !== "";
  return false;
}

/** "25 mi of 02144", "25 mi of your location", or "anywhere" when nothing is
 * actually limiting the search. Reads as the tail of a sentence ("Nothing
 * within …") and as the value half of the narrow disclosure's summary
 * ("Near · …"), which is why it carries no leading capital. */
export function describeLocationChoice(location: LocationPref): string {
  if (!radiusIsActive(location)) return "anywhere";
  const where = location.mode === "coords" ? "your location" : location.postal.trim();
  return `${location.radius} mi of ${where}`;
}

/**
 * The next radius out, or `null` when there is nowhere left to widen to.
 *
 * One step at a time rather than jumping straight to "anywhere": the visitor
 * picked a radius on purpose, and the button says where it is taking them
 * ("Widen to 50 mi"), so four taps is the worst case and every one of them
 * is a choice rather than a surprise. `RADIUS_OPTIONS` is
 * `[10, 25, 50, 100]`; "anywhere" is the feed's own extra choice on top of
 * it (`RadiusChoice` in `src/lib/geo.ts`), so it is what sits past 100.
 */
export function widerRadius(radius: RadiusChoice): RadiusChoice | null {
  if (radius === "anywhere") return null;
  const next = RADIUS_OPTIONS.find((option) => option > radius);
  return next ?? "anywhere";
}

/**
 * A thing the empty state offers to do about itself. Each one has to really
 * change the state that produced the empty page — `app/index.tsx` maps these
 * onto `setQ("")` / `setCategory(null)` / a persisted location change. A
 * button that only looks like it helps is worse than no button.
 */
export type FeedEmptyAction =
  | { readonly kind: "give"; readonly label: string }
  | { readonly kind: "clearSearch"; readonly label: string }
  | { readonly kind: "clearCategory"; readonly label: string }
  | { readonly kind: "widenRadius"; readonly label: string; readonly radius: RadiusChoice };

export type FeedEmptyKind = "catalogue" | "filtered" | "radius";

export type FeedEmptyState = {
  readonly kind: FeedEmptyKind;
  /** The word pressed into the rubber stamp above the words. */
  readonly stamp: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly line?: string;
  /** In emphasis order — the caller renders the first as the one primary. */
  readonly actions: readonly FeedEmptyAction[];
};

export type FeedEmptyInput = {
  q: string;
  category: Category | null;
  location: LocationPref;
};

/**
 * How much of the visitor's own search term the heading will echo back.
 *
 * The heading is `displayLg` — 40px — and the search box accepts anything,
 * so this is the difference between naming what was searched for and handing
 * a stranger control of the layout. Caught in the baseline rather than in
 * review: `feed-search-empty.jpg` was captured with `zzzznothingmatchesthis`
 * (22 characters, no space in it to break at), and the title ran off both
 * edges of its card. `EmptyState` breaks a long word rather than overflowing
 * now too — the two fixes are independent on purpose, since a term that is
 * merely long should wrap, and one that is absurd should be cut.
 */
const ECHOED_TERM_MAX = 24;

/** The typographic quotes the rest of the product's copy uses, around at most
 * `ECHOED_TERM_MAX` characters of whatever was typed. */
function quoted(text: string): string {
  const clipped = text.length > ECHOED_TERM_MAX ? `${text.slice(0, ECHOED_TERM_MAX).trimEnd()}…` : text;
  return `“${clipped}”`;
}

function filteredTitle(q: string, category: Category | null): string {
  const label = category === null ? null : CATEGORY_LABELS[category];
  if (q !== "" && label !== null) return `Nothing in ${label} matches ${quoted(q)}.`;
  if (q !== "") return `Nothing matches ${quoted(q)}.`;
  return `Nothing in ${label ?? "this category"} right now.`;
}

export function resolveFeedEmptyState({ q, category, location }: FeedEmptyInput): FeedEmptyState {
  const trimmedQ = q.trim();
  const filtered = trimmedQ !== "" || category !== null;
  const narrowedByRadius = radiusIsActive(location);
  const wider = widerRadius(location.radius);
  const widenAction: FeedEmptyAction | null =
    narrowedByRadius && wider !== null
      ? { kind: "widenRadius", label: wider === "anywhere" ? "Search anywhere" : `Widen to ${wider} mi`, radius: wider }
      : null;

  if (filtered) {
    // Deliberately says nothing about how much *is* on the table: this
    // component cannot see the unfiltered count, and "there are plenty of
    // others" would be its own invented claim the moment the catalogue is
    // genuinely empty and someone happens to have typed a word.
    return {
      kind: "filtered",
      stamp: "No match",
      eyebrow: "No matches",
      title: filteredTitle(trimmedQ, category),
      line: narrowedByRadius
        ? `You’re also only looking within ${describeLocationChoice(location)}. Drop a filter or widen the search.`
        : "Try a different word, or clear the filters to see everything on the table.",
      actions: [
        ...(trimmedQ !== "" ? ([{ kind: "clearSearch", label: "Clear search" }] as const) : []),
        ...(category !== null ? ([{ kind: "clearCategory", label: "All categories" }] as const) : []),
        ...(widenAction !== null ? [widenAction] : []),
      ],
    };
  }

  if (narrowedByRadius) {
    return {
      kind: "radius",
      stamp: "Too far",
      eyebrow: "Nearby",
      title: `Nothing within ${describeLocationChoice(location)} yet.`,
      line: "Widen the radius to see keepsakes further out — or be the first one near you.",
      actions: [
        ...(widenAction !== null ? [widenAction] : []),
        { kind: "give", label: "Give something" },
      ],
    };
  }

  // Nothing is filtered and nothing came back: the marketplace really is
  // empty, and this is the one case the original copy was written for.
  return {
    kind: "catalogue",
    stamp: "Empty",
    eyebrow: "Nothing yet",
    title: "Nothing here yet. Be the first to give something.",
    actions: [{ kind: "give", label: "Give something" }],
  };
}

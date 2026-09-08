/**
 * The regression test for "no page scrolls" (see `src/ui/Page.tsx`'s header
 * comment for the root cause). `app/+html.tsx` sets `html, body, #root {
 * height: 100% }` and, via expo-router's `ScrollViewStyleReset`, `body {
 * overflow: hidden }` — a reset built, on purpose, to hand scrolling
 * entirely to React Native `ScrollView`s (see
 * https://necolas.github.io/react-native-web/docs/setup/#root-element).
 * `Page`'s `ScrollView` renders its own internal `overflow-y: auto` box, so
 * — once it's actually working — `document.documentElement.scrollHeight`
 * stays pinned to the viewport height on purpose; the tall content lives
 * inside that inner box instead. That means the one useful, architecture-
 * correct version of "is this taller than the viewport" is asked of the
 * nearest scrollable ancestor of real content, not of `document`, which is
 * what `scrollableAncestorMetrics` below does. Before `Page` existed, no
 * route rendered a `ScrollView` at all, so content taller than the viewport
 * had nowhere to go but invisibly off the bottom of a `overflow: hidden`
 * box — and nothing in this suite or the screenshot scripts
 * (`scripts/screenshots-{v3,v4}.mjs`, which used to render every page "as if
 * scrolled" via `captureBeyondViewport`) could ever have caught it. Runs on
 * both the `mobile` and `desktop` projects, since the bug — and the fix —
 * is viewport-size-independent.
 */
import type { Locator } from "@playwright/test";
import { test, expect } from "./support/fixtures";
import { createApprovedListing, uniqueTitle } from "./support/api";

/** Comfortably past `STORY_MIN..STORY_MAX` (20..2000) — long enough that the
 * item page's story card alone is taller than any viewport this suite runs
 * at, on both mobile and desktop. */
const LONG_STORY =
  "This kettle has sat on my grandmother's stove for as long as anyone in the family can remember, through three house moves and at least as many burnt-out elements underneath it. "
    .repeat(10)
    .slice(0, 1900);

/**
 * Walks up from `locator`'s element looking for the `ScrollView` that
 * actually owns the scrolling — the nearest ancestor (including the element
 * itself) whose computed `overflow-y` is `auto`/`scroll` and whose content
 * genuinely overflows it. Returns its `scrollHeight`/`clientHeight`, or
 * `null` if the page never scrolls at all (the pre-fix state this spec
 * guards against).
 */
function scrollableAncestorMetrics(
  locator: Locator,
): Promise<{ scrollHeight: number; clientHeight: number } | null> {
  return locator.evaluate((start) => {
    let el: Element | null = start;
    while (el !== null) {
      const style = getComputedStyle(el);
      if (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        el.scrollHeight > el.clientHeight + 1
      ) {
        return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
      }
      el = el.parentElement;
    }
    return null;
  });
}

test.describe("scroll", () => {
  test("the feed is taller than the viewport, and a card below the fold becomes visible on scroll", async ({
    page,
    request,
  }) => {
    // Seed enough listings that the feed is unambiguously taller than the
    // viewport regardless of what else is already in the local D1 (other
    // specs' fixtures accumulate there too — see api.ts's header comment) —
    // this assertion should never pass by accident. Sequential, not
    // `Promise.all`: sixteen concurrent uploads-plus-creates against the
    // single local D1 SQLite file (see playwright.config.ts's comment on
    // that) intermittently 500s under contention — this only needs to be
    // reliable, not fast.
    const prefix = uniqueTitle("Scroll fixture");
    const listings = [];
    for (let index = 0; index < 16; index += 1) {
      listings.push(await createApprovedListing(request, { title: `${prefix} ${index}` }));
    }
    // The FIRST one seeded, not the last. The feed is newest-first, so the
    // last listing created is the card at the top of the table — and until
    // #219 that card was itself below the fold on a phone, which is the only
    // reason this assertion used to hold. It was passing on the defect: the
    // feed's own hero and filters filled the whole viewport, so "the newest
    // keepsake is off screen" was true and read as proof that scrolling
    // worked. With keepsakes on the first screenful it is 49% in view, and
    // the check has to point at something genuinely far down the table
    // instead. Sixteen listings up the page is unambiguous.
    const deepListing = listings[0];
    if (deepListing === undefined) throw new Error("expected at least one seeded listing");

    await page.goto("/");
    const lastCard = page.getByLabel(deepListing.title, { exact: true });
    await expect(lastCard).toBeAttached();

    // Polled, not measured once. `toBeAttached()` above resolves as soon as
    // the node exists, which is before the prints below it have laid out, so
    // a single read can catch the feed at a moment when nothing overflows
    // yet and report "no scrolling container" — a race that was always here
    // and that #219 made likelier by taking ~300px of hero and filters off
    // the top of the phone feed.
    await expect
      .poll(async () => (await scrollableAncestorMetrics(lastCard)) !== null, {
        message: "the feed should sit inside a real scrolling container",
      })
      .toBe(true);
    const metrics = await scrollableAncestorMetrics(lastCard);
    expect(metrics?.scrollHeight ?? 0).toBeGreaterThan(metrics?.clientHeight ?? 0);

    // Below the fold until scrolled to: this is the check a
    // `captureBeyondViewport` screenshot could never fail, and a page with no
    // `ScrollView` could never pass.
    await expect(lastCard).not.toBeInViewport();
    await lastCard.scrollIntoViewIfNeeded();
    await expect(lastCard).toBeInViewport();
  });

  test("an item page is taller than the viewport, and the Report button below the story becomes visible on scroll", async ({
    page,
    request,
  }) => {
    const listing = await createApprovedListing(request, {
      title: uniqueTitle("Scroll story kettle"),
      story: LONG_STORY,
    });

    await page.goto(`/item/${listing.id}`);
    await expect(page.getByText(listing.title, { exact: true })).toBeVisible();

    const reportButton = page.getByLabel("Report", { exact: true });
    await expect(reportButton).toBeAttached();
    const metrics = await scrollableAncestorMetrics(reportButton);
    expect(metrics, "the item page should sit inside a real scrolling container").not.toBeNull();
    expect(metrics?.scrollHeight ?? 0).toBeGreaterThan(metrics?.clientHeight ?? 0);

    await expect(reportButton).not.toBeInViewport();
    await reportButton.scrollIntoViewIfNeeded();
    await expect(reportButton).toBeInViewport();
  });
});

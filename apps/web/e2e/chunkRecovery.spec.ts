/**
 * Issue #272. `asyncRoutes` (#262) means a route's JS arrives as its own
 * content-hashed chunk(s) under `_expo/static/js/web/*`, not in the one
 * entry bundle, and a deploy rotates those hashes all at once. A tab left
 * open across a deploy that then needs a route it hasn't already loaded
 * requests a chunk that no longer exists — this reproduces exactly that,
 * against the real exported bundle and the real Worker
 * (`apps/api/src/index.ts`): the *first* request for anything this tab has
 * not already loaded is failed with a real 404, the same way a deploy
 * having moved that file would; every later request — including for a
 * *different* not-yet-loaded chunk — passes through untouched, because a
 * real deploy rotates every hash at once, so the guard's one reload lands
 * on a build where nothing 404s a second time.
 *
 * Two things have to hold together for the visitor to actually recover:
 *  - the server answers that miss with a real, uncached 404 rather than the
 *    SPA shell (`apps/api/src/index.ts`, unit-tested directly in
 *    `apps/api/test/chunkNotFound.test.ts`) — a shell response can't even
 *    be told apart from an ordinary route by the browser's `import()`;
 *  - the client (`useChunkRecoveryGuard.ts`) catches the rejected dynamic
 *    import and reloads once.
 *
 * Deliberately not pinned to *which* chunk fails first or *what* triggers
 * it — expo-router prefetches a visible `Link`'s target in the background,
 * so a chunk can 404 before anything is clicked at all, and different
 * exports need different numbers of chunks for the same route (measured:
 * earlier versions of this spec hard-coded the specific chunk(s) `/give`
 * needs by diffing exported HTML, and broke the moment an export changed
 * that shape). What's asserted instead is the property that actually
 * matters: the visitor is never left on a half-crashed, blank screen, and
 * "Give something" — the thing they actually came to do — eventually
 * succeeds, the same way it would in a fresh tab opened after the deploy
 * that broke the first attempt.
 *
 * `deepLinkColdLoad.spec.ts` is the sibling case this spec cannot replace:
 * that one proves a *fresh* load of every route works; this one is the one
 * case that can only be seen by loading a route that has NOT been visited
 * yet, in an already-running tab, and having its chunk(s) vanish
 * mid-session.
 */
import { test, expect } from "./support/fixtures";

test("a route whose chunk(s) were rotated out recovers instead of leaving the tab stuck", async ({ page }) => {
  const alreadyLoaded = new Set<string>();
  let interceptArmed = false;
  let hasFailedOnce = false;

  await page.route("**/_expo/static/js/web/*.js", async (route) => {
    const url = route.request().url();
    // Not armed yet (still establishing the baseline below), the chunk was
    // part of that baseline, or the one simulated miss already happened —
    // pass through to the real, still-present file. A real deploy replaces
    // every hash at once, so after the first miss triggers recovery,
    // nothing else 404s.
    if (!interceptArmed || alreadyLoaded.has(url) || hasFailedOnce) {
      await route.continue();
      return;
    }
    hasFailedOnce = true;
    await route.fulfill({
      status: 404,
      contentType: "text/plain",
      headers: { "cache-control": "no-store" },
      body: "Not found",
    });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "A free gifting marketplace" })).toBeVisible();
  await page.waitForLoadState("networkidle");

  // Baseline: every chunk this warm tab has genuinely already loaded, read
  // from the browser's own resource timing rather than guessed from the
  // static export — right regardless of what expo-router did or did not
  // prefetch in the background. Only a request for something NOT in this
  // set is eligible to be the one simulated miss below.
  const loaded = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((url) => url.includes("/_expo/static/js/web/")),
  );
  for (const url of loaded) alreadyLoaded.add(url);
  interceptArmed = true;

  // The feed has more than one "Give something" control (the header's and
  // the feed's own CTA — see `AppHeader.tsx`'s `dangerouslySingular`
  // comment); either exercises the same navigation, so the first is enough.
  // Whatever chunk(s) this needs that the tab hasn't already loaded is/are
  // exactly the request(s) a deploy can rotate out from under it.
  await page.getByRole("link", { name: /^Give/ }).first().click();
  await page.waitForLoadState("networkidle");

  await expect(page.getByText("Show us the keepsake.")).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/give\/?$/);

  // The whole point: a real miss happened (otherwise this spec would prove
  // nothing — it would pass identically with the fix reverted) and the
  // visitor still ended up on the screen they asked for.
  expect(hasFailedOnce).toBe(true);
});

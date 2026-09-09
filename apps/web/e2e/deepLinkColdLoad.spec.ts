/**
 * Async routes (`asyncRoutes: { web: "production" }`, `app.base.json`) splits
 * the single ~3.2MB entry bundle into one small per-route chunk plus a shared
 * `__common`/`entry` pair, so a route's exported HTML now references only the
 * chunk(s) that route needs — see `docs/runbooks/seo-audit.md`, "Still open",
 * item 2.
 *
 * The risk that split creates: a *cold* load of a deep route — a bookmark, a
 * shared link, a hard refresh — has never run any of the app's JavaScript
 * before, so nothing has warmed the router's lazy-chunk cache. If a route's
 * exported HTML were missing a `<script>` tag for its own chunk, or if
 * hydration assumed a sibling route's code was already loaded, this is where
 * it would show up: a blank `<div id="root">`, a 404 on a chunk URL, or a
 * hydration mismatch. Client-side navigation (clicking a `Link` from `/`)
 * cannot catch this, because by then the common chunk and the router runtime
 * are already resident — every other spec in this suite exercises exactly
 * that warm path.
 *
 * Every test below is the first and only `page.goto()` in a fresh
 * (per-test) browser context — no prior navigation, nothing pre-fetched —
 * and each asserts real rendered content, not merely a 200.
 */
import { test, expect, seedOwnerToken } from "./support/fixtures";
import { createApprovedListing, mintOwnerToken, uniqueTitle } from "./support/api";

test.describe("cold hard-load of every exported route", () => {
  test("/welcome renders the explainer", async ({ page }) => {
    await page.goto("/welcome");
    await expect(page.getByText("No passwords. No money.")).toBeVisible();
  });

  test("/give renders step one (photos)", async ({ page }) => {
    await page.goto("/give");
    await expect(page.getByText("Show us the keepsake.")).toBeVisible();
  });

  test("/give/story renders the story field", async ({ page }) => {
    await page.goto("/give/story");
    await expect(page.getByText("Tell its story.")).toBeVisible();
  });

  test("/give/details renders", async ({ page }) => {
    await page.goto("/give/details");
    await expect(page.getByText("A few details.")).toBeVisible();
  });

  test("/give/review renders", async ({ page }) => {
    await page.goto("/give/review");
    await expect(page.getByText("Take a last look.")).toBeVisible();
  });

  test("/give/email renders", async ({ page }) => {
    await page.goto("/give/email");
    await expect(page.getByText("Where should we reach you?")).toBeVisible();
  });

  test("/item/[id] renders the listing", async ({ page, request }) => {
    const listing = await createApprovedListing(request, { title: uniqueTitle("Cold-load compass") });
    await page.goto(`/item/${listing.id}`);
    await expect(page.getByText(listing.title, { exact: true })).toBeVisible();
  });

  test("/mine renders the empty state for a device with no identity", async ({ page }) => {
    await page.goto("/mine");
    await expect(page.getByText("You haven't given anything yet.")).toBeVisible();
  });

  test("/mine/[id] renders the request screen", async ({ page, context, request }) => {
    const ownerToken = mintOwnerToken();
    const listing = await createApprovedListing(request, { title: uniqueTitle("Cold-load thimble"), ownerToken });
    await seedOwnerToken(context, ownerToken);
    await page.goto(`/mine/${listing.id}`);
    await expect(page.getByText(listing.title, { exact: true })).toBeVisible();
  });

  test("/mine/email renders the empty state for a device with no identity", async ({ page }) => {
    await page.goto("/mine/email");
    await expect(page.getByText("Nothing to show yet")).toBeVisible();
  });

  test("/recover renders the request form", async ({ page }) => {
    await page.goto("/recover");
    await expect(page.getByText("Get back in.")).toBeVisible();
  });

  test("/recover/[token] renders the honest error state for an unknown token", async ({ page }) => {
    await page.goto("/recover/not-a-real-token");
    // Curly apostrophe here, unlike withdraw/confirm's straight one — a
    // pre-existing copy inconsistency in `app/recover/[token].tsx`, not
    // something this change touched.
    await expect(page.getByText("That link didn’t work", { exact: false })).toBeVisible();
  });

  test("/withdraw/[token] renders the honest error state for an unknown token", async ({ page }) => {
    await page.goto("/withdraw/not-a-real-token");
    await expect(page.getByText("That link didn't work")).toBeVisible();
  });

  test("/confirm/[token] renders the honest error state for an unknown token", async ({ page }) => {
    await page.goto("/confirm/not-a-real-token");
    await expect(page.getByText("That link didn't work")).toBeVisible();
  });

  test("/admin renders the login gate", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByText("Enter the admin token")).toBeVisible();
  });
});

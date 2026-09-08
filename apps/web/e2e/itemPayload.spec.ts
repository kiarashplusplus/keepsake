/**
 * `/item/:id` is served by the Worker, which already reads the row and its
 * photos to build the share card's tags — so it also inlines the exact
 * `PublicListing` JSON that `GET /api/listings/:id` would have answered
 * with, and the screen reads that instead of making the request.
 *
 * Asserted by counting requests rather than by timing: "it felt faster" is
 * not a test, and a payload that is inlined but ignored looks identical to
 * one that is used.
 */
import { test, expect } from "./support/fixtures";
import { createApprovedListing, uniqueTitle } from "./support/api";

test("a keepsake opened by its own URL renders without fetching the listing", async ({ page, request }) => {
  const listing = await createApprovedListing(request, { title: uniqueTitle("Brass compass") });

  const listingRequests: string[] = [];
  page.on("request", (req) => {
    if (new URL(req.url()).pathname === `/api/listings/${listing.id}`) listingRequests.push(req.url());
  });

  await page.goto(`/item/${listing.id}`);

  await expect(page.getByText(listing.title, { exact: true })).toBeVisible();
  expect(listingRequests).toHaveLength(0);
});

test("the shell served for an item page is the item route's, not the feed's", async ({ page, request }) => {
  // Since the static export stopped shipping an empty body, `/`'s HTML is
  // the feed — header, hero, search, category chips. Serving that here would
  // paint the feed for the moment before hydration swapped in a keepsake.
  const listing = await createApprovedListing(request, { title: uniqueTitle("Brass compass") });

  const response = await request.get(`/item/${listing.id}`);
  const html = await response.text();

  expect(html).toContain('id="ks-listing"');
  // The feed's own controls are the tell: the search field and the category
  // chips are in `/`'s exported markup and not in the item route's. (Not the
  // hero's line — "Give a keepsake a second life." is also the site-wide
  // description in the JSON-LD every page carries.)
  const body = html.slice(html.indexOf("<body"));
  expect(body).not.toContain('aria-label="Search"');
  expect(body).not.toContain("Books &amp; letters");
});

test("navigating from the feed to a second keepsake still fetches it", async ({ page, request }) => {
  // The inlined payload describes exactly one listing and stays in the
  // document after a client-side navigation. Believing it for the next one
  // would render the wrong story under the right URL — so the screen checks
  // the id, and here that means a real request goes out.
  const first = await createApprovedListing(request, { title: uniqueTitle("Brass compass") });
  const second = await createApprovedListing(request, { title: uniqueTitle("Enamel jug") });

  const fetched: string[] = [];
  page.on("request", (req) => {
    const path = new URL(req.url()).pathname;
    if (path.startsWith("/api/listings/")) fetched.push(path);
  });

  await page.goto(`/item/${first.id}`);
  await expect(page.getByText(first.title, { exact: true })).toBeVisible();
  expect(fetched).toHaveLength(0);

  await page.goto("/");
  await page.getByLabel(second.title, { exact: true }).click();

  // The title is on the card that was clicked as well as on the page it
  // opens (the feed's markup is still in the DOM through the transition), so
  // the URL is what says the navigation happened and the request list is
  // what this test is actually about.
  await page.waitForURL(new RegExp(`/item/${second.id}$`));
  await expect.poll(() => fetched).toContain(`/api/listings/${second.id}`);
  await expect(page.getByText(second.title, { exact: true }).last()).toBeVisible();
});

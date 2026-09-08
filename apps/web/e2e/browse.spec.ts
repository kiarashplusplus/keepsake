/** The feed: does a listing that exists actually reach a visitor, and do the
 * three controls above it (category, search, and the empty state that
 * follows a search with no answer) do what the URL says they do. */
import { test, expect } from "./support/fixtures";
import { createApprovedListing, uniqueTitle } from "./support/api";

test.describe("browse", () => {
  test("the home page renders the invitation and the feed controls", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByText("Give a keepsake a second life.")).toBeVisible();
    await expect(page.getByLabel("Search")).toBeVisible();
    await expect(page.getByLabel("Give something").first()).toBeVisible();
  });

  test("an approved listing shows up as a print on the table", async ({ page, request }) => {
    const listing = await createApprovedListing(request, { title: uniqueTitle("Copper kettle") });

    await page.goto("/");

    const card = page.getByLabel(listing.title, { exact: true });
    await expect(card).toBeVisible();
    await expect(card.getByText(listing.title, { exact: true })).toBeVisible();
    // The signature moment: a line of the story, in italic serif, on the card.
    await expect(card.getByText(/^“/)).toBeVisible();
  });

  test("choosing and clearing a category keeps the query string in sync", async ({ page }) => {
    await page.goto("/");
    // The feed only starts reflecting state into the URL once the stored
    // location preference has been merged in, so wait for the controls to be
    // live rather than racing that first `router.setParams`.
    await expect(page.getByLabel("Search")).toBeVisible();

    const category = page.getByLabel("Jewelry & watches", { exact: true });
    await category.click();

    await expect(page).toHaveURL(/[?&]category=jewelry_watches\b/);

    await category.click();
    await expect(page).not.toHaveURL(/[?&]category=/);

    await page.reload();
    await expect(page.getByLabel("Jewelry & watches", { exact: true })).toHaveAttribute("aria-pressed", "false");
  });

  test("searching narrows the feed to matching keepsakes", async ({ page, request }) => {
    const kept = await createApprovedListing(request, { title: uniqueTitle("Kettle") });
    const filteredOut = await createApprovedListing(request, { title: uniqueTitle("Brooch") });
    // The random suffix `uniqueTitle` adds is what makes this exact: it is a
    // single FTS token that no other listing in the local database has.
    const searchTerm = kept.title.split(" ").pop() as string;

    await page.goto("/");
    await expect(page.getByLabel(filteredOut.title, { exact: true })).toBeVisible();

    await page.getByLabel("Search").fill(searchTerm);

    await expect(page.getByLabel(kept.title, { exact: true })).toBeVisible();
    await expect(page.getByLabel(filteredOut.title, { exact: true })).toBeHidden();
  });

  test("a search with no answer gets the empty state, not a blank page", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByLabel("Search")).toBeVisible();

    await page.getByLabel("Search").fill("qzxwvutsrq");

    await expect(page.getByText("Nothing here yet. Be the first to give something.")).toBeVisible();
  });
});

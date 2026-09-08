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

  test("choosing a category writes it into the query string", async ({ page }) => {
    await page.goto("/");
    // The feed only starts reflecting state into the URL once the stored
    // location preference has been merged in, so wait for the controls to be
    // live rather than racing that first `router.setParams`.
    await expect(page.getByLabel("Search")).toBeVisible();

    await page.getByLabel("Jewelry & watches", { exact: true }).click();

    await expect(page).toHaveURL(/[?&]category=jewelry_watches\b/);
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

  test("a search with no answer offers a way out of the search, not an invitation to post", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByLabel("Search")).toBeVisible();

    await page.getByLabel("Search").fill("qzxwvutsrq");

    // Until #220 this asserted "Nothing here yet. Be the first to give
    // something." — the empty-*marketplace* copy, shown to a visitor looking
    // at a marketplace that is not empty. It described the wrong state and
    // offered the one action that cannot help: posting a keepsake does not
    // find the one you were looking for. So the assertion is now on the
    // distinction rather than on the words: the state names what was searched
    // for, and the way out is clearing the search.
    await expect(page.getByText(/Nothing matches/)).toBeVisible();
    await expect(page.getByLabel("Clear search")).toBeVisible();
    // The eyebrow, not the absence of a "Give something" button: the header
    // carries one of those at desktop widths, so asserting it is gone would
    // be asserting something about the chrome.
    await expect(page.getByText("No matches")).toBeVisible();

    await page.getByLabel("Clear search").click();

    await expect(page.getByLabel("Search")).toHaveValue("");
    await expect(page.getByText(/Nothing matches/)).toBeHidden();
  });
});

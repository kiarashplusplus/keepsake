/**
 * `/admin` — the token gate, the Hidden tab, and Restore putting a listing
 * back in front of people. Admin is one secret and one person, so the gate is
 * the whole authentication story and worth asserting from both sides.
 */
import { test, expect } from "./support/fixtures";
import { ADMIN_TOKEN, createApprovedListing, hideListingAsAdmin, uniqueTitle } from "./support/api";

async function signIn(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/admin");
  await page.getByLabel("Admin token").fill(ADMIN_TOKEN);
  await page.getByLabel("Enter").click();
  await expect(page.getByRole("tablist")).toBeVisible();
}

test("the token gate refuses a wrong token and accepts the real one", async ({ page }) => {
  await page.goto("/admin");
  await expect(page.getByText("Enter the admin token")).toBeVisible();

  await page.getByLabel("Admin token").fill("not-the-admin-token");
  await page.getByLabel("Enter").click();
  await expect(page.getByText("That token didn't work.")).toBeVisible();

  await page.getByLabel("Admin token").fill(ADMIN_TOKEN);
  await page.getByLabel("Enter").click();
  await expect(page.getByRole("tablist").getByLabel("Needs review", { exact: true })).toBeVisible();
});

test("a hidden listing sits in the Hidden tab and Restore puts it back on the feed", async ({ page, request }) => {
  const listing = await createApprovedListing(request, { title: uniqueTitle("Misfiled ledger") });
  // Hidden through the admin API rather than by three reporters: this test is
  // about the queue and Restore, and `report.spec.ts` already owns auto-hide.
  await hideListingAsAdmin(request, listing.id, "e2e fixture");

  await signIn(page);
  await page.getByRole("tablist").getByLabel("Hidden", { exact: true }).click();

  const card = page.getByText(listing.title, { exact: true });
  await expect(card).toBeVisible();

  // Scoped to *this* listing's card: other specs hide listings too, and they
  // all share this queue. `ancestor::*[...][1]` on a reverse axis is the
  // nearest enclosing element that owns a Restore control.
  await card.locator('xpath=ancestor::*[.//*[@aria-label="Restore"]][1]').getByLabel("Restore").click();
  await expect(page.getByText("Restored.")).toBeVisible();
  await expect(card).toBeHidden();

  await page.goto("/");
  await expect(page.getByLabel(listing.title, { exact: true })).toBeVisible();
});

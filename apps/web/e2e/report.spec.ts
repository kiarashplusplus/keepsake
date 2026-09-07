/**
 * Reports, and the auto-hide they add up to.
 *
 * `POST /api/listings/:id/reports` keys uniqueness off `sha256(day:ip)`, and
 * `REPORT_AUTOHIDE_THRESHOLD` counts distinct reporters — so this needs three
 * genuinely different client addresses. `wrangler dev` does honour an
 * incoming `CF-Connecting-IP` header (verified: two POSTs differing only in
 * that header produce two `reports` rows rather than a 409), so each context
 * here carries its own via `openFreshContext`, and no assertion has to be
 * skipped.
 */
import { test, expect, openFreshContext } from "./support/fixtures";
import { createApprovedListing, freshClientIp, uniqueTitle } from "./support/api";
import type { Page } from "@playwright/test";

async function submitReport(page: Page): Promise<void> {
  await page.getByLabel("Report").click();
  await page.getByRole("radio", { name: "Spam" }).click();
  await page.getByLabel("Submit").click();
}

test("reporting once is accepted; reporting twice from the same device is refused", async ({
  page,
  request,
}) => {
  const listing = await createApprovedListing(request, { title: uniqueTitle("Chipped saucer") });

  await page.goto(`/item/${listing.id}`);
  await expect(page.getByText(listing.title, { exact: true })).toBeVisible();

  await submitReport(page);
  await expect(page.getByText("Thanks. We'll take a look.")).toBeVisible();
  await page.getByLabel("Done").click();

  await submitReport(page);
  await expect(page.getByText("You've already reported this.")).toBeVisible();
});

test("three reports from three addresses pull the listing out of the feed", async ({
  browser,
  request,
}) => {
  const listing = await createApprovedListing(request, { title: uniqueTitle("Dubious teapot") });

  for (let reporter = 0; reporter < 3; reporter += 1) {
    const context = await openFreshContext(browser);
    const page = await context.newPage();
    await page.goto(`/item/${listing.id}`);
    await expect(page.getByText(listing.title, { exact: true })).toBeVisible();
    await submitReport(page);
    await expect(page.getByText("Thanks. We'll take a look.")).toBeVisible();
    await context.close();
  }

  // Hidden means gone from the public API and from the feed — not merely
  // flagged somewhere an admin has to notice. This `request` fixture is its
  // own `APIRequestContext` (not one of the three browser contexts above),
  // so — same reasoning as `give.spec.ts`'s shell fetch — it needs its own
  // explicit `CF-Connecting-IP` or it lands on the shared "unknown" bucket
  // `GET /api/listings/:id`'s `burst("RL_READ")` falls back to instead of a
  // test-owned address.
  const afterwards = await request.get(`/api/listings/${listing.id}`, {
    headers: { "CF-Connecting-IP": freshClientIp() },
  });
  expect(afterwards.status()).toBe(404);

  const viewer = await openFreshContext(browser);
  const viewerPage = await viewer.newPage();
  await viewerPage.goto("/");
  await expect(viewerPage.getByLabel("Search")).toBeVisible();
  await expect(viewerPage.getByLabel(listing.title, { exact: true })).toBeHidden();
  await viewer.close();
});

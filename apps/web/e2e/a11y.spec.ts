/**
 * axe-core over the four pages a stranger actually lands on, plus `/admin` —
 * Kiarash's own, not a stranger's, but the one he's most likely to be using
 * at 3am with the queue at 200 items, so its keyboard/bulk path (issue #11)
 * gets the same zero-exclusions bar as everything else here. The bar is zero
 * `serious`/`critical` violations — `moderate`/`minor` findings are reported
 * by the run but not failed on, since axe's heuristics there (landmark
 * structure over a react-native-web tree, for one) produce noise this app
 * can't meaningfully act on yet.
 *
 * The three findings this suite originally reported (an empty document title
 * on every SPA route, the faded step numerals, and three text colours on the
 * marketing page) have since been fixed, so nothing is excluded any more and
 * a regression in any of them fails here.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { test, expect } from "./support/fixtures";
import { ADMIN_TOKEN, createApprovedListing, hideListingAsAdmin, uniqueTitle } from "./support/api";
import type { Page } from "@playwright/test";

// axe reads computed colours at one instant, and both codebases fade content
// in on load (`apps/site`'s `.fade-up`, the app's own `MotionProvider`), so a
// scan that lands mid-animation invents contrast failures against a
// half-transparent foreground — observed as an intermittent `h1` violation on
// /about. Every animation here is already written to collapse under
// `prefers-reduced-motion`, which makes the scan deterministic without
// waiting on arbitrary timers.
test.use({ reducedMotion: "reduce" });

const BLOCKING_IMPACTS = new Set(["serious", "critical"]);

async function blockingViolations(
  page: Page,
  build: (b: AxeBuilder) => AxeBuilder = (b) => b,
): Promise<string[]> {
  const results = await build(new AxeBuilder({ page })).analyze();
  return results.violations
    .filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ""))
    .map(
      (violation) =>
        `${violation.impact}: ${violation.id} — ${violation.help} (${violation.nodes.length} node(s): ` +
        `${violation.nodes.map((node) => node.target.join(" ")).join(" | ")})`,
    );
}

test("the feed has no serious or critical accessibility violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByLabel("Search")).toBeVisible();

  expect(await blockingViolations(page)).toEqual([]);
});

test("an item page has no serious or critical accessibility violations", async ({
  page,
  request,
}) => {
  const listing = await createApprovedListing(request, { title: uniqueTitle("Pressed fern") });

  await page.goto(`/item/${listing.id}`);
  await expect(page.getByText(listing.title, { exact: true })).toBeVisible();

  // No exclusions: the Worker gives this page a real title, and nothing on it
  // fails contrast.
  expect(await blockingViolations(page)).toEqual([]);
});

test("the give flow has no serious or critical accessibility violations", async ({ page }) => {
  await page.goto("/give");
  await expect(page.getByText("Show us the keepsake.")).toBeVisible();

  expect(await blockingViolations(page)).toEqual([]);
});

test("the about page has no serious or critical accessibility violations", async ({ page }) => {
  // Static HTML from `apps/site`, copied into the export by
  // `scripts/copy-site.mjs` — a different codebase from everything above, and
  // the one page that ships without the React tree at all.
  await page.goto("/about");
  await expect(page.locator("h1")).toBeVisible();

  expect(await blockingViolations(page)).toEqual([]);
});

test("the admin queue — including a checked row and the bulk toolbar it opens — has no serious or critical accessibility violations", async ({
  page,
  request,
}) => {
  const listing = await createApprovedListing(request, { title: uniqueTitle("Foxed postcard") });
  await hideListingAsAdmin(request, listing.id, "e2e fixture");

  await page.goto("/admin");
  await page.getByLabel("Admin token").fill(ADMIN_TOKEN);
  await page.getByLabel("Enter").click();
  await expect(page.getByRole("tablist")).toBeVisible();

  await page.getByRole("tablist").getByLabel("Hidden", { exact: true }).click();
  await expect(page.getByText(listing.title, { exact: true })).toBeVisible();

  // Scans the queue at rest first — the common case — then again with a row
  // checked and the bulk toolbar it reveals on screen, since that's new
  // markup (the checkbox, the roving-focus ring, `role="toolbar"`) this
  // issue added and none of it gets a pass by never being exercised.
  expect(await blockingViolations(page)).toEqual([]);

  await page.getByLabel(`Select ${listing.title}`).click();
  await expect(page.getByText("1 selected")).toBeVisible();

  expect(await blockingViolations(page)).toEqual([]);
});

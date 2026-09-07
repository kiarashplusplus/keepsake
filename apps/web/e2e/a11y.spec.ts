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
 *
 * Two things this file did NOT cover until issue #173, both of which are the
 * project's own failure mode rather than an ordinary gap — the suite was
 * green over ground it had never walked, and two comments in the tree said
 * otherwise:
 *
 *  - The consent banner. Every scan here takes its context from
 *    `./support/fixtures`, whose `context` fixture seeds a consent decision
 *    precisely so the banner stays out of the way — so the first interactive
 *    element every new visitor meets was structurally invisible to axe. The
 *    "consent banner" block at the bottom builds its own unseeded contexts
 *    (the way `consent.spec.ts` does) so the banner is genuinely in the DOM.
 *  - Dark mode. `[data-theme="dark"]` is a second, complete colour system and
 *    no scan had ever run under it. The "dark mode" block below does, and
 *    asserts `data-theme` really is `dark` before scanning, so it cannot
 *    quietly pass by having scanned the light palette twice.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { test, expect } from "./support/fixtures";
import { ADMIN_TOKEN, createApprovedListing, freshClientIp, hideListingAsAdmin, uniqueTitle } from "./support/api";
import { seedVisited } from "./support/visited";
import { BASE_URL } from "./support/constants";
import type { Browser, Page } from "@playwright/test";

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

test("the new-visitor explainer has no serious or critical accessibility violations", async ({ page }) => {
  // Direct navigation, not through `/`: the redirect in `+html.tsx` only
  // fires for the root path, so this context's seeded "visited" flag (every
  // other test in this suite relies on it) doesn't need to be unset here.
  await page.goto("/welcome");
  await expect(page.getByText("No accounts. No money.")).toBeVisible();

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
  await expect(page.getByRole("tablist", { name: "Queue status" })).toBeVisible();

  await page.getByRole("tablist", { name: "Queue status" }).getByLabel("Hidden", { exact: true }).click();
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

test("the Observatory panel has no serious or critical accessibility violations", async ({ page }) => {
  await page.goto("/admin");
  await page.getByLabel("Admin token").fill(ADMIN_TOKEN);
  await page.getByLabel("Enter").click();
  await expect(page.getByRole("tablist", { name: "Admin sections" })).toBeVisible();

  await page.getByRole("tablist", { name: "Admin sections" }).getByLabel("Observatory", { exact: true }).click();

  // The panel renders a good deal of markup axe has opinions about and the
  // queue does not exercise: a second tablist (the window selector), the
  // severity chips in `needs_attention`, the bar chart's labelled columns,
  // and the three-state source boxes. Waiting on the window selector rather
  // than on a data-dependent string keeps this from turning into a test
  // about how much traffic the fixture database happens to have.
  await expect(page.getByRole("tablist", { name: "Observatory window" })).toBeVisible();

  expect(await blockingViolations(page)).toEqual([]);

  // Again on a different window, because switching re-renders every section
  // from a fresh payload — including the empty-series path a 1-day window
  // hits on a database this quiet, which is exactly where a missing label
  // or an unlabelled empty state would hide.
  await page.getByRole("tablist", { name: "Observatory window" }).getByLabel("1 day", { exact: true }).click();
  await expect(page.getByRole("tablist", { name: "Observatory window" })).toBeVisible();

  expect(await blockingViolations(page)).toEqual([]);
});

/**
 * A context that has NOT answered the banner.
 *
 * `openFreshContext()` in `support/fixtures.ts` is no good here: it seeds a
 * decision too, for the same reason the shared fixture does. This seeds the
 * "has visited before" flag only, so `/` is the feed rather than the
 * new-visitor explainer (issue #44) — a fresh consent decision has nothing to
 * do with whether this device has been here before, and conflating them would
 * put these assertions on the wrong page.
 */
async function openWithBanner(browser: Browser, colorScheme: "light" | "dark") {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    colorScheme,
    reducedMotion: "reduce",
    extraHTTPHeaders: { "CF-Connecting-IP": freshClientIp() },
  });
  await seedVisited(context);
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.locator("#ks-consent")).toBeVisible();
  return { context, page };
}

test.describe("the consent banner", () => {
  // ~15 elements no scan in this file could reach before #173: a `role="region"`
  // overlay pinned at `bottom:0; z-index:9999`, two equally-weighted buttons, a
  // disclosure button carrying `aria-expanded`/`aria-controls`, and four
  // checkbox rows each depending on a `for`/`id` pairing built by
  // `categoryRow()` in `public/consent.js`.
  for (const colorScheme of ["light", "dark"] as const) {
    test(`has no serious or critical accessibility violations in ${colorScheme} mode`, async ({ browser }) => {
      const { context, page } = await openWithBanner(browser, colorScheme);

      // The banner's card is deliberately the same cream index card in both
      // themes (see `public/consent.js`), but the page behind it is not — and
      // a scan that had silently run against the light palette twice would be
      // exactly the kind of check that cannot fail.
      expect(await page.evaluate(() => document.documentElement.dataset.theme ?? null)).toBe(colorScheme);

      // As a visitor first meets it: the two-button bar, closed.
      expect(await blockingViolations(page)).toEqual([]);

      // And again with the preferences open, which is where the four checkbox
      // rows and the Save control live — markup that gets a free pass by
      // never being on screen during a scan.
      await page.locator("#ks-consent-customise").click();
      await expect(page.locator("#ks-consent-panel")).toBeVisible();
      await expect(page.locator("#ks-consent-customise")).toHaveAttribute("aria-expanded", "true");

      expect(await blockingViolations(page)).toEqual([]);
      await context.close();
    });
  }
});

test.describe("dark mode", () => {
  // `[data-theme="dark"]` is a whole second colour system and nothing had ever
  // scanned it (#173). These mirror the light scans above rather than adding
  // new pages: the point is the palette, not the markup.
  test.use({ colorScheme: "dark" });

  async function expectDark(page: Page): Promise<void> {
    // The app's pre-hydration script in `app/+html.tsx` resolves the default
    // "system" mode from `prefers-color-scheme`, which is what `colorScheme`
    // above sets. Asserting it here is what stops this block from passing by
    // scanning the light palette a second time.
    expect(await page.evaluate(() => document.documentElement.dataset.theme ?? null)).toBe("dark");
  }

  test("the feed has no serious or critical accessibility violations in dark mode", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByLabel("Search")).toBeVisible();
    await expectDark(page);

    expect(await blockingViolations(page)).toEqual([]);
  });

  test("the give flow has no serious or critical accessibility violations in dark mode", async ({ page }) => {
    await page.goto("/give");
    await expect(page.getByText("Show us the keepsake.")).toBeVisible();
    await expectDark(page);

    expect(await blockingViolations(page)).toEqual([]);
  });

  test("an item page has no serious or critical accessibility violations in dark mode", async ({ page, request }) => {
    const listing = await createApprovedListing(request, { title: uniqueTitle("Enamel pin") });

    await page.goto(`/item/${listing.id}`);
    await expect(page.getByText(listing.title, { exact: true })).toBeVisible();
    await expectDark(page);

    expect(await blockingViolations(page)).toEqual([]);
  });

  test("the new-visitor explainer has no serious or critical accessibility violations in dark mode", async ({ page }) => {
    await page.goto("/welcome");
    await expect(page.getByText("No accounts. No money.")).toBeVisible();
    await expectDark(page);

    expect(await blockingViolations(page)).toEqual([]);
  });
});

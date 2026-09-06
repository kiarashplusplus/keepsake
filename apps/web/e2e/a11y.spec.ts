/**
 * axe-core over the four pages a stranger actually lands on. The bar is zero
 * `serious`/`critical` violations — `moderate`/`minor` findings are reported
 * by the run but not failed on, since axe's heuristics there (landmark
 * structure over a react-native-web tree, for one) produce noise this app
 * can't meaningfully act on yet.
 *
 * Three real findings are excluded below, each narrowly and each named. They
 * are genuine bugs, not test noise; every exclusion is a rule id or a CSS
 * selector, never a blanket "ignore this page", so a *new* violation of the
 * same kind anywhere else still fails this suite.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { test, expect } from "./support/fixtures";
import { createApprovedListing, uniqueTitle } from "./support/api";
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

/**
 * `expo export` writes an empty `<title data-rh="true"></title>` (react-helmet's
 * placeholder, since no route sets one) *ahead of* the shell's own
 * `<title>Keepsake</title>` from `app/+html.tsx`, and the first title element
 * in `<head>` is the one that counts — so every SPA route hydrates with an
 * empty document title. `/item/:id` is the exception, because the Worker's
 * HTMLRewriter removes every `<title>` before appending the listing's own.
 * The fix belongs in `app/_layout.tsx`/`app/+html.tsx`, outside this change.
 */
const EMPTY_DOCUMENT_TITLE = "document-title";

async function blockingViolations(page: Page, build: (b: AxeBuilder) => AxeBuilder = (b) => b): Promise<string[]> {
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

  expect(await blockingViolations(page, (b) => b.disableRules([EMPTY_DOCUMENT_TITLE]))).toEqual([]);
});

test("an item page has no serious or critical accessibility violations", async ({ page, request }) => {
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

  const violations = await blockingViolations(page, (b) =>
    b
      .disableRules([EMPTY_DOCUMENT_TITLE])
      // `src/ui/StepNumerals.tsx` fades the steps still ahead to `opacity:
      // 0.4` on ink, which lands under 4.5:1 for 12px type. The numerals are
      // decorative — the enclosing `progressbar` already carries "Step 1 of
      // 5" as its accessible name — but the honest fix is a colour decision,
      // not a label, so it is reported rather than made here.
      .exclude('[aria-label^="Step "]'),
  );
  expect(violations).toEqual([]);
});

test("the about page has no serious or critical accessibility violations", async ({ page }) => {
  // Static HTML from `apps/site`, copied into the export by
  // `scripts/copy-site.mjs` — a different codebase from everything above, and
  // the one page that ships without the React tree at all.
  await page.goto("/about");
  await expect(page.locator("h1")).toBeVisible();

  const violations = await blockingViolations(page, (b) =>
    // Three text colours in `apps/site/public/site.css` fail 4.5:1: the lead
    // `.deck` paragraph, the numbered `.step-number` glyphs, and the
    // `.why-grid` body copy. `apps/site` is outside this change's scope.
    b.exclude(".deck").exclude(".step-number").exclude(".why-grid p"),
  );
  expect(violations).toEqual([]);
});

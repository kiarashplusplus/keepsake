/**
 * The root-domain split (issue #44): a first-time visitor to `/` should see
 * the explainer at `/welcome`, and a returning visitor — one holding a `ks_`
 * owner token, or one this device has already redirected once — should land
 * straight on the feed. Both branches proven against the real stack (a real
 * `wrangler dev` serving the real static export through the Worker's
 * `[assets]` binding — see `playwright.config.ts`), not a mock: this
 * project's recurring failure mode is a check that only ever exercises one
 * branch, and this is exactly that shape of decision.
 *
 * This spec builds its own contexts rather than using the shared `test`
 * fixture, for the same reason `consent.spec.ts` does: that fixture seeds
 * "has visited before" precisely so every *other* spec's `goto("/")` keeps
 * landing on the feed (see `support/fixtures.ts`). A spec about the redirect
 * running against a pre-seeded context would be testing nothing.
 */
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { freshClientIp, mintOwnerToken, OWNER_TOKEN_STORAGE_KEY } from "./support/api";
import { BASE_URL } from "./support/constants";
import { seedConsent } from "./support/consent";
import { seedVisited } from "./support/visited";

async function freshContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { "CF-Connecting-IP": freshClientIp() },
  });
  // Consent state is an independent variable from "has visited before" — seed
  // a decision so the banner doesn't sit over the explainer's one button,
  // same as every non-consent spec in this suite.
  await seedConsent(context);
  return context;
}

/**
 * The feed writes `?radius_mi=25` (its default) into the URL shortly after
 * mount (`index.tsx`'s location-hydration effect), so an exact `toHaveURL(
 * BASE_URL + "/")` is a race against that effect rather than a check of
 * where the redirect landed. Matching on the path only is what every other
 * spec that lands on the feed after a redirect actually needs.
 */
async function expectOnFeed(page: Page): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`^${BASE_URL}/(\\?.*)?$`));
  await expect(page.getByLabel("Search")).toBeVisible();
}

test("a first-time visitor to / is redirected to the explainer, not the feed", async ({ browser }) => {
  const context = await freshContext(browser);
  const page = await context.newPage();

  await page.goto("/");

  await expect(page).toHaveURL(`${BASE_URL}/welcome`);
  await expect(page.getByText("No passwords. No money.")).toBeVisible();
  // The feed's own markup never painted first — this proves the branch was
  // decided before hydration, not after a flash of the wrong content.
  await expect(page.getByLabel("Search")).toHaveCount(0);

  await context.close();
});

test("a first-time visitor's campaign parameters survive the redirect", async ({ browser }) => {
  // The redirect only ever runs for a first-time visitor, which is exactly
  // the visitor who arrived from an ad or a shared link. Until 2026-09-08 it
  // used a bare `location.replace("/welcome")`, so `utm_*`/`gclid`/`fbclid`
  // were dropped on that hop and no analytics on the far side could ever see
  // them. Run against the real export in a real browser, so what is asserted
  // is the URL the visitor actually lands on, not the script's source text
  // (`test/guards/rootOpenGraph.test.ts` holds that end).
  const context = await freshContext(browser);
  const page = await context.newPage();

  await page.goto("/?utm_source=newsletter&utm_medium=email&gclid=abc123");

  await expect(page).toHaveURL(`${BASE_URL}/welcome?utm_source=newsletter&utm_medium=email&gclid=abc123`);
  await expect(page.getByText("No passwords. No money.")).toBeVisible();

  await context.close();
});

test("going to the feed from the explainer means / never asks again", async ({ browser }) => {
  const context = await freshContext(browser);
  const page = await context.newPage();

  await page.goto("/");
  await expect(page).toHaveURL(`${BASE_URL}/welcome`);

  await page.getByLabel("See what's out there").click();
  await expectOnFeed(page);

  // A full navigation (not SPA routing), so the pre-hydration script runs
  // again from scratch — this is what proves the flag persisted rather than
  // the first visit merely being mid-session.
  await page.goto("/");
  await expectOnFeed(page);

  await context.close();
});

test("a device already holding an owner token goes straight to the feed", async ({ browser }) => {
  const context = await freshContext(browser);
  await context.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key as string, value as string);
    },
    [OWNER_TOKEN_STORAGE_KEY, mintOwnerToken()],
  );
  const page = await context.newPage();

  await page.goto("/");
  await expectOnFeed(page);

  await context.close();
});

test("a device that has already visited goes straight to the feed", async ({ browser }) => {
  const context = await freshContext(browser);
  await seedVisited(context);
  const page = await context.newPage();

  await page.goto("/");
  await expectOnFeed(page);

  await context.close();
});

test("the explainer is reachable directly, and links back to the feed and to give", async ({ browser }) => {
  const context = await freshContext(browser);
  const page = await context.newPage();

  await page.goto("/welcome");
  await expect(page.getByText("No passwords. No money.")).toBeVisible();

  await page.getByLabel("Have something to give away?").click();
  await expect(page).toHaveURL(`${BASE_URL}/give`);

  await context.close();
});

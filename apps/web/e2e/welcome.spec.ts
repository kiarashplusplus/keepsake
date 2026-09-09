/**
 * The root-domain split (issue #44): a first-time visitor to `/` should see
 * the explainer, and a returning visitor — one holding a `ks_` owner token,
 * or one this device has shown the explainer once — should land straight on
 * the feed. Both branches proven against the real stack (a real `wrangler
 * dev` serving the real static export through the Worker's `[assets]`
 * binding — see `playwright.config.ts`), not a mock: this project's
 * recurring failure mode is a check that only ever exercises one branch, and
 * this is exactly that shape of decision.
 *
 * Since 2026-09-09 the explainer shows AT `/` rather than by redirecting to
 * `/welcome`. `app/+html.tsx`'s pre-hydration script used to
 * `location.replace("/welcome")`, which made the homepage a redirect to
 * every crawler that renders JavaScript — PageSpeed Insights reported it as
 * one, by name. Now the script marks `<html>` and the stylesheet shows the
 * explainer instead of the feed on the same page (`src/lib/firstVisit.ts`).
 * So the assertions here are about the URL *not* changing, which is the
 * whole point, as much as about what is on screen.
 *
 * This spec builds its own contexts rather than using the shared `test`
 * fixture, for the same reason `consent.spec.ts` does: that fixture seeds
 * "has visited before" precisely so every *other* spec's `goto("/")` keeps
 * landing on the feed (see `support/fixtures.ts`). A spec about the first
 * visit running against a pre-seeded context would be testing nothing.
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
 * where the visitor landed. Matching on the path only is what every other
 * spec that lands on the feed actually needs.
 */
async function expectOnFeed(page: Page): Promise<void> {
  await expect(page).toHaveURL(new RegExp(`^${BASE_URL}/(\\?.*)?$`));
  await expect(page.getByLabel("Search")).toBeVisible();
}

/** The explainer, on screen, with the feed not merely off screen but out of
 * the accessibility tree — `display: none`, not scrolled away. */
async function expectOnExplainer(page: Page): Promise<void> {
  await expect(page.getByText("No passwords. No money.")).toBeVisible();
  await expect(page.getByLabel("Search")).toBeHidden();
}

test("a first-time visitor to / sees the explainer at /, and is not redirected", async ({ browser }) => {
  const context = await freshContext(browser);
  const page = await context.newPage();

  // Any console error is a failure here, and a hydration mismatch is the
  // one this test exists to catch: the explainer and the feed are both in
  // the static HTML and both in the hydrated tree, and if the two ever
  // disagreed React would log it and re-render from scratch — visibly, as a
  // flash, and invisibly to every other assertion in this file.
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  // The feed is in this document, hidden; nothing of it should be fetched
  // until the visitor asks for it. Both requests, not just page 1: the first
  // version of this gate left `/api/feed/shelves` going out under the
  // explainer on production (measured 2026-09-09 against the live bytes).
  const feedRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/feed")) feedRequests.push(new URL(request.url()).pathname);
  });

  await page.goto("/");

  // The URL is the assertion. `/welcome` was where this used to land.
  await expect(page).toHaveURL(`${BASE_URL}/`);
  await expectOnExplainer(page);
  // Decided before hydration, not after: the attribute the stylesheet keys
  // on is set by the inline script in `<head>`, so it is there from the
  // first paint and stays there until the visitor chooses the feed.
  await expect(page.locator("html")).toHaveAttribute("data-ks-first-visit", "1");

  await page.waitForLoadState("networkidle");
  expect(consoleErrors).toEqual([]);
  expect(feedRequests).toEqual([]);

  // And the moment the visitor chooses the feed, both go out.
  await page.getByLabel("See what's out there").click();
  await expect(page.getByLabel("Search")).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(feedRequests).toContain("/api/feed");
  expect(feedRequests).toContain("/api/feed/shelves");

  await context.close();
});

test("a first-time visitor's campaign parameters are still in the URL", async ({ browser }) => {
  // There is no hop for them to die on any more — the reason the old
  // redirect had to carry `location.search` across — but a first-timer from
  // an ad is exactly the visitor this branch runs for, so it stays asserted
  // against the URL the visitor actually has.
  const context = await freshContext(browser);
  const page = await context.newPage();

  await page.goto("/?utm_source=newsletter&utm_medium=email&gclid=abc123");

  await expect(page).toHaveURL(`${BASE_URL}/?utm_source=newsletter&utm_medium=email&gclid=abc123`);
  await expectOnExplainer(page);

  await context.close();
});

test("a first-time visitor who arrives with a search gets the feed, searching", async ({ browser }) => {
  // The `SearchAction` in the root JSON-LD sends a client to `/?q=…`, and
  // that client has never been here. It asked for a search, not a pitch.
  const context = await freshContext(browser);
  const page = await context.newPage();

  await page.goto("/?q=teacup");

  await expectOnFeed(page);
  await expect(page.getByLabel("Search")).toHaveValue("teacup");
  await expect(page.getByText("No passwords. No money.")).toBeHidden();

  await context.close();
});

test("going to the feed from the explainer switches in place, and / never asks again", async ({ browser }) => {
  const context = await freshContext(browser);
  const page = await context.newPage();

  await page.goto("/");
  await expectOnExplainer(page);

  await page.getByLabel("See what's out there").click();
  await expectOnFeed(page);
  await expect(page.getByText("No passwords. No money.")).toBeHidden();
  await expect(page.locator("html")).not.toHaveAttribute("data-ks-first-visit");

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
  await expect(page.getByText("No passwords. No money.")).toBeHidden();

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

test("the explainer is reachable directly at /welcome, and links back to the feed and to give", async ({ browser }) => {
  const context = await freshContext(browser);
  const page = await context.newPage();

  await page.goto("/welcome");
  await expect(page.getByText("No passwords. No money.")).toBeVisible();

  // Real anchors, not buttons that happen to navigate: a `Button` inside a
  // `Link asChild` renders as `<a href>` since 2026-09-09 (`ui/Button.tsx`),
  // which is what lets a crawler follow `/welcome` → `/` and `/welcome` →
  // `/give`, and what `getByRole("link")` is asserting.
  await expect(page.getByRole("link", { name: "See what's out there" })).toHaveAttribute("href", "/");
  const give = page.getByRole("link", { name: "Have something to give away?" });
  await expect(give).toHaveAttribute("href", "/give");

  await give.click();
  await expect(page).toHaveURL(`${BASE_URL}/give`);

  await context.close();
});

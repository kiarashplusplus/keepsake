/**
 * The November 2026 launch announcement (`src/features/launch/`): a dialog
 * with one burst of confetti over the first route a browser lands on, until
 * the meetup on the 28th is over.
 *
 * What this proves, against the real export served by the real Worker, that
 * jest cannot: that the dialog actually opens over a real page before a
 * visitor can touch it, that one press gets rid of it AND that it stays
 * gone across a reload (a real `localStorage` round trip), that it returns
 * once on launch day with the other message, and that it is absent from the
 * routes an email link lands on and from the calendar after the 28th.
 *
 * The clock is pinned in every test — this feature is a function of the
 * date, and an unpinned spec would start failing on 29 November for the
 * correct reason. `setFixedTime` rather than `install`: it fixes `Date`
 * and leaves timers and `requestAnimationFrame` running, which the app
 * needs to boot.
 *
 * Builds its own contexts: the shared fixture seeds the announcement as
 * already dismissed (`support/launch.ts`), which is right for every other
 * spec and would make this one test nothing.
 */
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { freshClientIp } from "./support/api";
import { BASE_URL } from "./support/constants";
import { seedConsent } from "./support/consent";
import { seedVisited } from "./support/visited";

const BEFORE = new Date(2026, 10, 17, 12, 0, 0);
const LAUNCH_DAY = new Date(2026, 10, 27, 9, 0, 0);
const AFTER = new Date(2026, 10, 29, 9, 0, 0);

async function open(browser: Browser, at: Date, options: { reducedMotion?: "reduce" | "no-preference" } = {}) {
  const context: BrowserContext = await browser.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { "CF-Connecting-IP": freshClientIp() },
    reducedMotion: options.reducedMotion ?? "no-preference",
  });
  await seedConsent(context);
  await seedVisited(context);
  const page: Page = await context.newPage();
  await page.clock.setFixedTime(at);
  return { context, page };
}

const dialog = (page: Page) => page.getByRole("dialog");

test("before launch: the dialog opens over the feed, throws confetti, and one press lets you in for good", async ({ browser }) => {
  const { context, page } = await open(browser, BEFORE);
  await page.goto("/");

  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toContainText("We launch Nov 27.");
  await expect(dialog(page)).toContainText("10 days to go");
  await expect(dialog(page)).toContainText("Saturday, November 28");
  await expect(page.getByTestId("launch-confetti")).toBeAttached();

  await dialog(page).getByRole("button", { name: "Come on in" }).click();
  await expect(dialog(page)).toHaveCount(0);
  // The site underneath is the real one and is now usable. The home link,
  // because it is the one piece of chrome labelled the same at every width
  // (the header's give link is "Give" on a phone).
  await expect(page.getByRole("link", { name: "Keepsake, home" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("link", { name: "Keepsake, home" })).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);

  // …and comes back exactly once, with the other message, on the day.
  await page.clock.setFixedTime(LAUNCH_DAY);
  await page.reload();
  await expect(dialog(page)).toContainText("We're open.");
  await dialog(page).getByRole("button", { name: "Start looking" }).click();
  await page.reload();
  await expect(page.getByRole("link", { name: "Keepsake, home" })).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);

  await context.close();
});

test("Escape dismisses it too, and reduced motion gets the dialog without the confetti", async ({ browser }) => {
  const { context, page } = await open(browser, BEFORE, { reducedMotion: "reduce" });
  await page.goto("/welcome");

  await expect(dialog(page)).toBeVisible();
  await expect(page.getByTestId("launch-confetti")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);

  await context.close();
});

test("it stays off the routes an email link lands on, and off the calendar after the meetup", async ({ browser }) => {
  const quiet = await open(browser, BEFORE);
  await quiet.page.goto("/unsubscribe/not-a-real-token");
  await expect(quiet.page.locator("#root")).not.toBeEmpty();
  await quiet.page.waitForLoadState("networkidle");
  await expect(dialog(quiet.page)).toHaveCount(0);
  await quiet.context.close();

  const late = await open(browser, AFTER);
  await late.page.goto("/");
  await expect(late.page.getByRole("link", { name: "Keepsake, home" })).toBeVisible();
  await late.page.waitForLoadState("networkidle");
  await expect(dialog(late.page)).toHaveCount(0);
  await late.context.close();
});

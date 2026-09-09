/**
 * What a visitor gets before — and without — JavaScript.
 *
 * `web.output: "static"` means `expo export` renders every route to HTML at
 * build time, and for most of this app's life that HTML was empty: the root
 * `ThemeProvider` returned `null` until an async `localStorage` read landed,
 * effects do not run in a static render, so every exported page shipped
 * `<div id="root">` with a Suspense comment inside it and nothing else. The
 * product only appeared once ~200 KB of JavaScript had downloaded, parsed and
 * hydrated, and anything that does not run JavaScript — a crawler, an
 * unfurler, a visitor on a bad connection — saw a blank document.
 *
 * These specs run with `javaScriptEnabled: false`, which is the only way to
 * assert that honestly: with JS on, a page that took two seconds to appear
 * and a page that was in the HTML look identical to a passing test.
 *
 * They are contexts built by hand rather than the shared fixture, because
 * that fixture seeds `localStorage` through an init script — which needs
 * JavaScript.
 */
import { test, expect, type Browser } from "@playwright/test";
import { BASE_URL } from "./support/constants";
import { freshClientIp } from "./support/api";

async function noScriptPage(browser: Browser) {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    javaScriptEnabled: false,
    extraHTTPHeaders: { "CF-Connecting-IP": freshClientIp() },
  });
  return { context, page: await context.newPage() };
}

test("the feed's chrome and controls are in the HTML, with no JavaScript at all", async ({ browser }) => {
  const { context, page } = await noScriptPage(browser);

  // No `waitForLoadState("networkidle")`, no polling: with scripting off,
  // whatever is on screen after the response is parsed is what the server
  // sent.
  await page.goto("/");

  await expect(page.getByText("Give a keepsake a second life.")).toBeVisible();
  await expect(page.getByLabel("Search")).toBeVisible();
  // The header's way to give. It is a `Button` inside a `Link asChild`, so
  // it is a button to the accessibility tree, and its label depends on the
  // width the static render assumed — hence the alternation, the same one
  // `browse.spec.ts` uses for the same control.
  await expect(page.getByRole("button", { name: /^Give( something)?$/ }).first()).toBeVisible();
  // The category chips are the feed's own controls, not chrome.
  await expect(page.getByText("Books & letters")).toBeVisible();

  // And the feed says it is fetching, not that there is nothing here. The
  // static render has no listings — it cannot — so the one thing it must not
  // do is tell a visitor the site is empty.
  await expect(page.getByText("Nothing here yet.")).toHaveCount(0);

  await context.close();
});

test("the explainer is readable with no JavaScript", async ({ browser }) => {
  // `/welcome` is where every first-time visitor lands, including from an ad.
  const { context, page } = await noScriptPage(browser);

  await page.goto("/welcome");

  await expect(page.getByText("No passwords. No money.")).toBeVisible();
  await expect(page.getByText(/They photograph it, write what it is/)).toBeVisible();

  await context.close();
});

test("the give flow's first step is in the HTML too", async ({ browser }) => {
  const { context, page } = await noScriptPage(browser);

  await page.goto("/give");

  await expect(page.getByText("Show us the keepsake.")).toBeVisible();

  await context.close();
});

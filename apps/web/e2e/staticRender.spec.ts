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

/** `browser.newContext()` ignores the project's `use`, so the viewport is
 * stated here rather than inherited — these tests are about what a given
 * width gets out of one file, so the width has to be the thing under control
 * rather than a Playwright default that can change under us. */
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

async function noScriptPage(browser: Browser, viewport: { width: number; height: number } = DESKTOP) {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    javaScriptEnabled: false,
    viewport,
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
  // The header's way to give. It is a `Button` inside a `Link asChild`, so it
  // is a button to the accessibility tree. This used to accept
  // `/^Give( something)?$/` "because its label depends on the width the
  // static render assumed" — which was this file describing the bug the
  // viewport switch fixes, as though it were a fact of life. The context
  // above is a desktop, so the label is now knowable.
  await expect(page.getByRole("button", { name: "Give something" }).first()).toBeVisible();
  // The category chips are the feed's own controls, not chrome.
  await expect(page.getByText("Books & letters")).toBeVisible();

  // And the feed says it is fetching, not that there is nothing here. The
  // static render has no listings — it cannot — so the one thing it must not
  // do is tell a visitor the site is empty.
  await expect(page.getByText("Nothing here yet.")).toHaveCount(0);

  await context.close();
});

/**
 * The one file, laid out two ways, by nothing but CSS.
 *
 * `expo export` renders `/` once with no viewport, and Cloudflare serves
 * those exact bytes to every device — no `Vary`, one cache entry. Every
 * width-dependent decision therefore has to be the stylesheet's, because a
 * `useWindowDimensions()` branch resolves at build time (to 0, hence to the
 * phone layout) and ships that to everyone. It did: production's `/` served
 * the phone header and the collapsed location controls to desktops until
 * hydration swapped them, which is the snap this proves is gone.
 *
 * Scripting is off, so nothing here can be hydration doing the work — what
 * each viewport shows is what the shared bytes plus a media query produce.
 * Both directions are asserted, because a fix that merely moved the baked
 * width from narrow to wide would pass a desktop-only version of this test.
 */
test("one export lays out as a desktop and as a phone, with no JavaScript to choose", async ({ browser }) => {
  const desktop = await noScriptPage(browser, DESKTOP);
  await desktop.page.goto("/");

  // Wide: the full hero, the secondary nav, and the location controls open.
  await expect(desktop.page.getByText(/Some things are too full of memory/)).toBeVisible();
  await expect(desktop.page.getByRole("link", { name: "Browse" })).toBeVisible();
  await expect(desktop.page.getByRole("link", { name: "About" })).toBeVisible();
  await expect(desktop.page.getByRole("button", { name: "Use my location" })).toBeVisible();
  // ...and neither the phone's short label nor its collapsed summary row.
  await expect(desktop.page.getByRole("button", { name: "Give", exact: true })).toBeHidden();
  await expect(desktop.page.getByRole("button", { name: /^Near · / })).toBeHidden();

  await desktop.context.close();

  const phone = await noScriptPage(browser, PHONE);
  await phone.page.goto("/");

  // Narrow: the hero cut to its headline, one short Give, the controls folded
  // behind the summary that stands in for them (issue #219).
  await expect(phone.page.getByText("Give a keepsake a second life.")).toBeVisible();
  await expect(phone.page.getByRole("button", { name: "Give", exact: true })).toBeVisible();
  await expect(phone.page.getByRole("button", { name: /^Near · / })).toBeVisible();
  await expect(phone.page.getByText(/Some things are too full of memory/)).toBeHidden();
  await expect(phone.page.getByRole("link", { name: "Browse" })).toBeHidden();
  await expect(phone.page.getByRole("button", { name: "Use my location" })).toBeHidden();

  await phone.context.close();
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

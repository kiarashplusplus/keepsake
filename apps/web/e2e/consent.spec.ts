/**
 * The consent gate, proved against the real stack.
 *
 * Every test here is written so that it FAILS if the guard it covers is
 * removed — that is the point, given this project's recurring failure mode is
 * a guard that cannot fire. Each one was confirmed by breaking the thing it
 * watches; see the report accompanying the change.
 *
 * These specs build their own contexts rather than using the shared `test`
 * fixture, because that fixture seeds a decision precisely so the banner stays
 * out of every *other* spec's way (see `support/fixtures.ts`). A consent spec
 * running against a pre-seeded context would be testing nothing.
 *
 * The two `<meta>` tags carrying the Google Ads id and the Cloudflare beacon
 * token are injected by a route handler instead of being baked into the
 * export. They come from `EXPO_PUBLIC_*` at build time, and an export run in
 * CI has neither set — so a spec that depended on the build would be a spec
 * that quietly passes by never loading anything, which is exactly the
 * false-PASS this suite is supposed to rule out.
 */
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { freshClientIp } from "./support/api";
import { BASE_URL } from "./support/constants";
import { CONSENT_STORAGE_KEY, CONSENT_VERSION, consentRecord } from "./support/consent";
import { seedVisited } from "./support/visited";

const ADS_HOST = "www.googletagmanager.com";
const ANALYTICS_HOST = "static.cloudflareinsights.com";

const INJECTED_META =
  '<meta name="ks-google-ads-id" content="AW-000000001">' +
  '<meta name="ks-cf-beacon-token" content="e2e-beacon-token">';

interface ConsentHarness {
  context: BrowserContext;
  page: Page;
  /** Hostnames of every third-party script actually requested, in order. */
  thirdParty: string[];
}

async function openHarness(
  browser: Browser,
  options: { gpc?: boolean; seed?: string } = {},
): Promise<ConsentHarness> {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { "CF-Connecting-IP": freshClientIp() },
  });
  // Consent state and "has visited before" (issue #44) are independent
  // variables — a fresh consent decision has nothing to do with whether this
  // device has been redirected to the explainer already. Without this, every
  // `goto("/")` below would hit `/welcome` instead of the page these
  // assertions are actually about.
  await seedVisited(context);

  if (options.gpc === true) {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "globalPrivacyControl", { value: true, configurable: true });
    });
  }
  if (options.seed !== undefined) {
    await context.addInitScript(
      ([key, value]) => {
        window.localStorage.setItem(key as string, value as string);
      },
      [CONSENT_STORAGE_KEY, options.seed],
    );
  }

  // Registered first, so the more specific third-party handler below wins for
  // its own hosts: Playwright matches route handlers in reverse registration
  // order.
  await context.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = await response.text();
    await route.fulfill({ response, body: body.replace("<head>", `<head>${INJECTED_META}`) });
  });

  const thirdParty: string[] = [];
  await context.route(/googletagmanager\.com|cloudflareinsights\.com/, async (route) => {
    thirdParty.push(new URL(route.request().url()).hostname);
    // Fulfilled empty rather than let out to the real internet: the assertion
    // is that the request was MADE, and a suite that reaches Google is a suite
    // that fails on a train.
    await route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
  });

  return { context, page: await context.newPage(), thirdParty };
}

function banner(page: Page) {
  return page.locator("#ks-consent");
}

/** Give any deferred injection a chance to happen, so an empty `thirdParty`
 * means "nothing was requested", not "nothing has been requested yet". */
async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(500);
}

test.describe("the consent gate", () => {
  test("loads nothing third-party before the visitor has decided", async ({ browser }) => {
    const { context, page, thirdParty } = await openHarness(browser);
    await page.goto("/");
    await expect(banner(page)).toBeVisible();
    await settle(page);

    expect(thirdParty).toEqual([]);
    expect(await page.locator(`script[src*="${ADS_HOST}"]`).count()).toBe(0);
    expect(await page.locator(`script[src*="${ANALYTICS_HOST}"]`).count()).toBe(0);
    await context.close();
  });

  test("accepting loads both, and the banner goes away", async ({ browser }) => {
    const { context, page, thirdParty } = await openHarness(browser);
    await page.goto("/");
    await page.getByRole("button", { name: "Accept all" }).click();
    await expect(banner(page)).toBeHidden();
    await expect.poll(() => [...thirdParty].sort()).toEqual([ANALYTICS_HOST, ADS_HOST]);
    await context.close();
  });

  test("rejecting keeps them out, and still does after a reload", async ({ browser }) => {
    const { context, page, thirdParty } = await openHarness(browser);
    await page.goto("/");
    await page.getByRole("button", { name: "Reject all" }).click();
    await expect(banner(page)).toBeHidden();
    await settle(page);
    expect(thirdParty).toEqual([]);

    await page.reload();
    // The decision survived: no second prompt.
    await expect(banner(page)).toBeHidden();
    await settle(page);
    expect(thirdParty).toEqual([]);
    await context.close();
  });

  test("GPC refuses advertising without asking, and says so", async ({ browser }) => {
    const { context, page, thirdParty } = await openHarness(browser, { gpc: true });
    await page.goto("/");
    await expect(page.locator("#ks-consent-gpc")).toBeVisible();
    await expect(page.locator("#ks-consent-gpc")).toContainText("Global Privacy Control");
    // The primary button cannot claim to grant something the browser refuses.
    await expect(page.locator("#ks-consent-accept")).toHaveText("Accept analytics");

    await page.locator("#ks-consent-accept").click();
    await expect.poll(() => thirdParty).toEqual([ANALYTICS_HOST]);
    await settle(page);
    expect(thirdParty).not.toContain(ADS_HOST);

    // And it is visible after the banner is gone, so a returning visitor is
    // not left guessing.
    await expect(page.getByText("Global Privacy Control honoured")).toBeVisible();
    await context.close();
  });

  test("GPC out-ranks an advertising grant stored before it was switched on", async ({ browser }) => {
    const { context, page, thirdParty } = await openHarness(browser, {
      gpc: true,
      seed: consentRecord({ analytics: true, advertising: true, saleOptOut: false }),
    });
    await page.goto("/");
    await expect(banner(page)).toBeHidden();
    await settle(page);
    expect(thirdParty).toEqual([ANALYTICS_HOST]);
    await context.close();
  });

  test("a version bump re-prompts", async ({ browser }) => {
    const current = await openHarness(browser, { seed: consentRecord({ analytics: true, advertising: true }) });
    await current.page.goto("/");
    await expect(banner(current.page)).toBeHidden();
    await current.context.close();

    // The same decision, written under the previous schema. A decision about
    // different categories is not a decision about these ones.
    const stale = await openHarness(browser, {
      seed: consentRecord({ analytics: true, advertising: true, version: CONSENT_VERSION - 1 }),
    });
    await stale.page.goto("/");
    await expect(banner(stale.page)).toBeVisible();
    await settle(stale.page);
    expect(stale.thirdParty).toEqual([]);
    await stale.context.close();
  });

  test("the choice can be reopened from the app and from a static page", async ({ browser }) => {
    const { context, page } = await openHarness(browser, { seed: consentRecord() });

    await page.goto("/");
    await expect(banner(page)).toBeHidden();
    await page.getByRole("button", { name: "Privacy choices" }).click();
    await expect(banner(page)).toBeVisible();
    // Reopened onto the choices themselves, not onto a two-button bar the
    // visitor has already answered.
    await expect(page.locator("#ks-consent-panel")).toBeVisible();

    // `/about` is static HTML from apps/site — a different codebase, the same
    // banner, because there is only one.
    await page.goto("/about");
    await expect(banner(page)).toBeHidden();
    await page.locator("[data-ks-consent]").click();
    await expect(banner(page)).toBeVisible();
    await expect(page.locator("#ks-consent-panel")).toBeVisible();
    await context.close();
  });

  test("reject is exactly as easy as accept", async ({ browser }) => {
    const { context, page } = await openHarness(browser);
    await page.goto("/");

    const reject = page.locator("#ks-consent-reject");
    const accept = page.locator("#ks-consent-accept");
    const rejectBox = await reject.boundingBox();
    const acceptBox = await accept.boundingBox();
    expect(rejectBox).not.toBeNull();
    expect(acceptBox).not.toBeNull();

    // Same row, same size, one click each. A reject that is smaller, or
    // further down, or behind "manage preferences", is the pattern regulators
    // actually fine people for.
    expect(Math.abs((rejectBox?.height ?? 0) - (acceptBox?.height ?? 0))).toBeLessThanOrEqual(1);
    expect(Math.abs((rejectBox?.width ?? 0) - (acceptBox?.width ?? 0))).toBeLessThanOrEqual(1);
    expect(Math.abs((rejectBox?.y ?? 0) - (acceptBox?.y ?? 0))).toBeLessThanOrEqual(1);
    // Reject comes first in reading and tab order.
    expect(rejectBox?.x ?? 0).toBeLessThan(acceptBox?.x ?? 0);

    // ...and the same TREATMENT, not merely the same box (#223). This test
    // measured geometry only, and geometry was never the defect: the two were
    // always the same size in the same row, while `Accept all` wore the
    // filled stamp red that every primary action in the product wears and
    // `Reject all` wore a near-white outline. Equal size, unequal weight —
    // which is the half of "symmetry in choice" a bounding box cannot see, so
    // this guard could not have failed on the thing the issue was about.
    //
    // Asserted as an equality between the two buttons rather than against
    // hard-coded hexes: the point is that they match each other, and a
    // palette change that moves both together is not a regression.
    // `public/consent.js` is where the chosen pair and its contrast ratio are
    // written down.
    const treatment = (locator: ReturnType<typeof page.locator>) =>
      locator.evaluate((node) => {
        const computed = getComputedStyle(node as Element);
        return [
          computed.backgroundColor,
          computed.borderTopColor,
          computed.borderTopWidth,
          computed.color,
          computed.boxShadow,
          computed.fontFamily,
          computed.fontSize,
          computed.fontWeight,
          computed.letterSpacing,
          computed.textTransform,
        ].join(" | ");
      });

    expect(await treatment(accept)).toBe(await treatment(reject));
    // The bluntest form of the same statement, and the one that fails first
    // if someone re-introduces a per-button modifier class.
    expect(await accept.getAttribute("class")).toBe(await reject.getAttribute("class"));
    await context.close();
  });

  test("does not cover the primary action on a 390px viewport", async ({ browser }) => {
    const { context, page } = await openHarness(browser);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(banner(page)).toBeVisible();

    // Playwright's own actionability check refuses a click that another
    // element would intercept, so both of these assert coverage rather than
    // merely geometry.
    //
    // The Give control, by either label: #219 dropped the hero's own button
    // at phone width (the header already carries one) and the narrow header
    // calls it "Give", so naming only "Give something" made this test fail
    // for a reason that had nothing to do with consent.
    const cta = page.getByRole("button", { name: /^Give( something)?$/ }).first();
    await expect(cta).toBeVisible();
    await cta.click({ trial: true, timeout: 5000 });

    // And the category chips, which is the stronger half now that #223 has
    // docked the banner to the bottom edge. The Give control lives in the
    // header, at the top of the page, so a bottom-docked banner passes that
    // check whatever it does; the chips are the row the issue actually
    // reported the floating banner landing on top of.
    const chip = page.getByRole("button", { name: "All", exact: true }).first();
    await expect(chip).toBeVisible();
    await chip.click({ trial: true, timeout: 5000 });
    await context.close();
  });
});

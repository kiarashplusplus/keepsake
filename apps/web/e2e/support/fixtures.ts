/**
 * The suite's `test`/`expect`. Two things every spec gets for free:
 *
 *  - a `clientIp` unique to the test, pushed onto the browser context as
 *    `CF-Connecting-IP`. See `freshClientIp()` in `./api.ts` for why the whole
 *    suite would otherwise rate-limit itself.
 *  - `seedOwnerToken()`, which plants a device identity in `localStorage`
 *    before the app boots, so a context can *be* a giver without walking the
 *    give flow first.
 *  - a consent decision already on file, so `/consent.js`'s banner is not
 *    sitting over the bottom of a 390px viewport intercepting the "Continue"
 *    every other spec is trying to click. It seeds a REFUSAL, so the rest of
 *    the suite runs against the same nothing-loaded document a privacy-minded
 *    visitor gets. Two places build their own contexts precisely so they see
 *    the banner: `consent.spec.ts`, and the "consent banner" block at the
 *    bottom of `a11y.spec.ts` (which asks only for `browser`, so this fixture
 *    never runs for it). Until #173 that second one did not exist and this
 *    comment claimed it did — the banner had never been scanned by axe at all.
 *  - a "has visited before" flag already on file (issue #44), so `/` is the
 *    feed and not the new-visitor explainer. `welcome.spec.ts` builds its
 *    own context precisely so it sees the redirect.
 */
/* eslint-disable react-hooks/rules-of-hooks --
 * `eslint-config-expo`'s React rules see Playwright's fixture callback
 * parameter — conventionally named `use` — as a React hook call in a
 * non-component function. It is neither; there is no React in this file. */
import { test as base, expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { freshClientIp, OWNER_TOKEN_STORAGE_KEY } from "./api";
import { seedConsent } from "./consent";
import { seedVisited } from "./visited";
import { BASE_URL } from "./constants";

export const test = base.extend<{ clientIp: string }>({
  // eslint-disable-next-line no-empty-pattern
  clientIp: async ({}, use) => {
    await use(freshClientIp());
  },

  context: async ({ context, clientIp }, use) => {
    await context.setExtraHTTPHeaders({ "CF-Connecting-IP": clientIp });
    await seedConsent(context);
    await seedVisited(context);
    await use(context);
  },
});

export { expect };

/**
 * The control with `label` on the screen the visitor is actually looking at.
 *
 * React Navigation keeps the previous screen of a stack mounted (hidden) when
 * it pushes the next one, so a label that repeats across steps — "Continue",
 * four times in the give flow — matches more than one node and trips
 * Playwright's strict mode. The stale copies are genuinely `display: none`,
 * so filtering on visibility picks the live one without guessing at DOM order.
 */
export function onScreen(page: Page, label: string): Locator {
  return page.getByLabel(label, { exact: true }).filter({ visible: true });
}

/**
 * A second browser with its own cookie jar, `localStorage` and client address
 * — the "different person, different device" the request and report specs
 * need. `browser.newContext()` does not inherit the project's `use` options,
 * so `baseURL` has to be handed over explicitly.
 */
export async function openFreshContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { "CF-Connecting-IP": freshClientIp() },
  });
  // Same reason as the `context` fixture above: a second browser is still a
  // browser that has never answered the banner, or seen the site before.
  await seedConsent(context);
  await seedVisited(context);
  return context;
}

/**
 * `src/lib/ownerToken.ts` reads the token straight out of `localStorage` on
 * mount (`/mine` decides whether to render the dashboard or the "you haven't
 * given anything yet" empty state from a synchronous read), so this has to
 * land before the first script runs — hence `addInitScript` rather than an
 * `evaluate` after `goto`.
 */
export async function seedOwnerToken(context: BrowserContext, token: string): Promise<void> {
  await context.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key as string, value as string);
    },
    [OWNER_TOKEN_STORAGE_KEY, token],
  );
}

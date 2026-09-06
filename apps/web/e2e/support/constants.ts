/** The one place the suite's origin is written down: `playwright.config.ts`
 * builds both `baseURL` and the `wrangler dev --port` flag from it, and specs
 * that open their own `browser.newContext()` (which does *not* inherit the
 * project's `use` options) pass it explicitly. */
export const PORT = 8787;
export const BASE_URL = `http://127.0.0.1:${PORT}`;

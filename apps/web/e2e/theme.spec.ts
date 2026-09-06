/**
 * Dark mode, and the flash that must not happen.
 *
 * Two separate mechanisms have to agree: `src/ui/theme.tsx` writes
 * `data-theme` after hydration, and the inline script in `app/+html.tsx`
 * writes it synchronously in `<head>` from `localStorage` on the *next* load.
 * Only the second one prevents a flash of the light table, and the only way
 * to tell them apart is to look at `data-theme` before the first frame is
 * painted — which is what the `requestAnimationFrame` in the init script
 * below captures.
 */
import { test, expect } from "./support/fixtures";

const FIRST_PAINT_PROBE = () => {
  (window as unknown as { __ksThemeAtFirstPaint?: string | null }).__ksThemeAtFirstPaint = null;
  requestAnimationFrame(() => {
    (window as unknown as { __ksThemeAtFirstPaint?: string | null }).__ksThemeAtFirstPaint =
      document.documentElement.dataset.theme ?? null;
  });
};

const readTheme = () => document.documentElement.dataset.theme ?? null;
const readFirstPaintTheme = () =>
  (window as unknown as { __ksThemeAtFirstPaint?: string | null }).__ksThemeAtFirstPaint ?? null;

test("dark mode survives a reload with no flash of the light table", async ({ page, context }) => {
  await context.addInitScript(FIRST_PAINT_PROBE);

  await page.goto("/");
  // The toggle cycles light -> dark -> system, starting from "system", and
  // names its current state — so click until it says dark rather than
  // assuming a fixed number of presses.
  const toggle = page.getByLabel(/^Theme: /);
  await expect(toggle).toBeVisible();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if ((await toggle.getAttribute("aria-label")) === "Theme: dark. Tap to change.") break;
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("aria-label", "Theme: dark. Tap to change.");
  await expect.poll(() => page.evaluate(readTheme)).toBe("dark");

  await page.reload();

  // Already dark at the first frame, before React has hydrated anything.
  await expect.poll(() => page.evaluate(readFirstPaintTheme)).toBe("dark");
  expect(await page.evaluate(readTheme)).toBe("dark");
  await expect(page.getByLabel(/^Theme: /)).toHaveAttribute("aria-label", "Theme: dark. Tap to change.");
});

/**
 * Viewport screenshots for UX review, and the three things that make a set
 * of them worth comparing to the last set.
 *
 * **Viewport only, never `fullPage`.** The whole point of `docs/qa/README.md`'s
 * first rule — a full-page capture of a page nobody could scroll looked
 * perfect for a week while M0's "no page scrolls" bug shipped. These are what
 * a visitor actually sees before touching the scroll wheel; `scroll.spec.ts`
 * is what proves the rest of the page is reachable.
 *
 * **Settled, not merely loaded.** `page.screenshot()` fires the moment it is
 * asked, which for this app means a real chance of catching a web font
 * swapping in, a photo still decoding, or a Reanimated transition halfway
 * through — none of which is a UX signal, all of which produce a diff on the
 * next run. `settle()` below waits for the things that report their own
 * completion, `animations: "disabled"` freezes the CSS ones, and
 * `waitForVisualStability()` covers what neither reaches by simply watching
 * the viewport until it stops moving.
 *
 * **A file path a human can read.** `docs/qa/baseline/<project>/<name>.png`,
 * committed, so a pull request can point at "the item page got taller on
 * mobile" instead of describing it. See `docs/qa/baseline/README.md` for what
 * that directory is and is not (it is evidence, not a pixel gate).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BrowserContext, Page, TestInfo } from "@playwright/test";

/** Repo-root-relative: `apps/web/e2e/support` -> four levels up. */
export const BASELINE_DIR = path.resolve(__dirname, "../../../../docs/qa/baseline");

const THEME_SOURCE = fs.readFileSync(path.resolve(__dirname, "../../src/ui/theme.tsx"), "utf8");

/**
 * Read out of `src/ui/theme.tsx` rather than restated here, for the same
 * reason `support/consent.ts` and `support/visited.ts` read theirs out of the
 * app: a key that drifts between the app and this fixture would silently stop
 * seeding the dark table, and the capture would look like "dark mode
 * regressed" rather than "the fixture is stale".
 */
function themeStorageKey(): string {
  const match = /const THEME_MODE_STORAGE_KEY = "([^"]+)";/.exec(THEME_SOURCE);
  if (!match?.[1]) throw new Error("could not read THEME_MODE_STORAGE_KEY out of src/ui/theme.tsx");
  return match[1];
}

export const THEME_STORAGE_KEY = themeStorageKey();

/**
 * Plant a theme choice before the first script runs.
 *
 * `app/+html.tsx`'s pre-hydration script reads this key synchronously in
 * `<head>` and writes `data-theme` before the first paint, so seeding it here
 * (rather than clicking the toggle three times) is both faster and closer to
 * what a returning visitor's second page load does — which is the state
 * `theme.spec.ts` exists to protect.
 */
export async function seedTheme(
  context: BrowserContext,
  mode: "light" | "dark" | "system",
): Promise<void> {
  await context.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key as string, value as string);
    },
    [THEME_STORAGE_KEY, mode],
  );
}

/**
 * Wait for the things that finish: web fonts, decoding images, the image
 * transitions after them, and two animation frames of layout. Each wait is
 * bounded — a font that never loads or an image that never errors must slow a
 * capture down, not hang it until the test times out with nothing written.
 *
 * The `PHOTO_FADE_MS` pause is not padding. `expo-image` cross-fades its
 * blurhash placeholder out once the real photo decodes, and that fade is
 * driven from JavaScript rather than by a CSS animation `animations:
 * "disabled"` could freeze. Without the pause, captures land at random points
 * in it: two consecutive runs of this suite differed on twelve frames, by as
 * much as 32% of the pixels on the dark item page, with no code change in
 * between — a baseline nobody could diff.
 */
const PHOTO_FADE_MS = 500;

async function settle(page: Page): Promise<void> {
  await page.evaluate(async (fadeMs) => {
    const bounded = <T>(promise: Promise<T>, ms: number) =>
      Promise.race([promise, new Promise<void>((resolve) => setTimeout(resolve, ms))]);

    await bounded(document.fonts.ready, 3000);
    await bounded(
      Promise.all(
        Array.from(document.images)
          .filter((image) => !image.complete)
          .map(
            (image) =>
              new Promise<void>((resolve) => {
                image.addEventListener("load", () => resolve(), { once: true });
                image.addEventListener("error", () => resolve(), { once: true });
              }),
          ),
      ),
      3000,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, fadeMs));
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }, PHOTO_FADE_MS);
  await waitForVisualStability(page);
}

/** How long to let the pixels keep moving before giving up and capturing
 * anyway. A capture that hangs here would write nothing at all, which is
 * worse than one noisy frame. */
const STABILITY_TIMEOUT_MS = 4000;
/** Gap between probes. Long enough that a spring visibly advances between
 * two of them — sampling faster mostly proves the compositor is idle. */
const STABILITY_INTERVAL_MS = 120;

/**
 * Poll until the viewport stops changing, then let the caller capture.
 *
 * The waits above handle everything that reports its own completion. What is
 * left is `Print.tsx` dropping each card in on a Reanimated spring: it is
 * driven from JavaScript, so `animations: "disabled"` does not freeze it and
 * `PHOTO_FADE_MS` only lands mid-flight at a slightly more consistent point.
 *
 * The fixed pause alone was not enough — measured on this branch, two runs of
 * the *same commit* against the *same seeded catalogue* differed on 24 of 76
 * frames, every one of them a screen with cards on it (the feed, the item
 * page, `/mine`, the review step). A third of the baseline was noise, and it
 * was exactly the third a reviewer most wants to diff.
 *
 * Comparing successive screenshots rather than watching for an animation to
 * end keeps this agnostic about which library drew the motion: whatever
 * settles, this notices. Probes use the same `scale`/`animations` settings as
 * the real capture so they measure the frame that is about to be written, at
 * a lower quality because only the comparison matters, not the bytes.
 */
async function waitForVisualStability(page: Page): Promise<void> {
  const deadline = Date.now() + STABILITY_TIMEOUT_MS;
  let previous: string | null = null;

  while (Date.now() < deadline) {
    const frame = await page.screenshot({
      scale: "css",
      type: "jpeg",
      quality: 40,
      animations: "disabled",
      caret: "hide",
    });
    const digest = createHash("sha1").update(frame).digest("hex");
    if (digest === previous) return;
    previous = digest;
    await page.waitForTimeout(STABILITY_INTERVAL_MS);
  }
}

/**
 * One baseline frame.
 *
 * Every call site asserts something visible *first* — the title on the item
 * page, "Take a last look." on the review step — so a capture cannot quietly
 * succeed against a blank page or a spinner. A screenshot spec with no
 * assertions in front of it is a check that cannot fail, which is the one
 * failure mode this repository keeps re-learning (see the status notes in
 * `docs/design/README.md`).
 */
export async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await settle(page);
  const file = path.join(BASELINE_DIR, testInfo.project.name, `${name}.jpg`);
  await page.screenshot({
    path: file,
    // `scale: "css"` keeps the file one pixel per CSS pixel even though the
    // mobile project renders at deviceScaleFactor 2: the page still lays out
    // and picks assets the way it does on a real phone, and the committed
    // file stays 390x844.
    scale: "css",
    // JPEG, measured rather than assumed: the same 46-frame set is ~20 MB as
    // PNG and ~3 MB at quality 85 (a 1280x800 feed goes 541 KB -> 101 KB).
    // These are refreshed every time a screen changes, and each refresh is a
    // fresh binary blob in history — 20 MB a time is how a QA directory
    // becomes something people delete rather than maintain. What is lost is
    // exact pixel fidelity, which nothing here is judged on: contrast is
    // `a11y.spec.ts`'s axe run, and a 1px colour question belongs in the
    // running app, not in a screenshot.
    type: "jpeg",
    quality: 85,
    animations: "disabled",
    caret: "hide",
  });
  await testInfo.attach(name, { path: file, contentType: "image/jpeg" });
}

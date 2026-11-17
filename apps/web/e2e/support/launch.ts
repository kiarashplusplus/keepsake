/**
 * The launch announcement (`src/features/launch/`), kept out of the way.
 *
 * Until 29 November 2026 `LaunchModal` opens over the first route any
 * browser lands on. This suite is about the product behind it, so every
 * context is seeded as having already dismissed it — the same arrangement,
 * for the same reason, as `seedConsent` and `seedVisited`. `launch.spec.ts`
 * builds its own unseeded contexts precisely so it sees the dialog.
 *
 * The storage key is read OUT OF the source rather than restated: a key
 * that drifted would put a dialog over every spec, which looks like "the
 * whole suite broke", not "the fixture is stale".
 */
import fs from "node:fs";
import path from "node:path";
import type { BrowserContext } from "@playwright/test";

const SOURCE = fs.readFileSync(path.resolve(__dirname, "../../src/features/launch/launchPlan.ts"), "utf8");
const match = /export const LAUNCH_DISMISSED_KEY = "([^"]+)";/.exec(SOURCE);
if (!match?.[1]) throw new Error("could not read LAUNCH_DISMISSED_KEY out of src/features/launch/launchPlan.ts");

export const LAUNCH_DISMISSED_KEY = match[1];

/** Plant "dismissed on launch day", which covers the countdown too. */
export async function seedLaunchDismissed(context: BrowserContext): Promise<void> {
  await context.addInitScript((key) => {
    window.localStorage.setItem(key as string, "live");
  }, LAUNCH_DISMISSED_KEY);
}

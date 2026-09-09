/**
 * The "has been here before" signal from issue #44's root-domain split.
 *
 * `apps/web/app/+html.tsx`'s pre-hydration script shows a first-time
 * visitor the explainer at `/` (in place, by marking `<html>` — no longer a
 * redirect to `/welcome`); anyone who already holds an owner token or has
 * this flag set goes straight to the feed. The storage key is read OUT
 * OF `+html.tsx` rather than hardcoded a second time here, same reasoning as
 * `support/consent.ts`'s `CONSENT_STORAGE_KEY`: a key that drifts between
 * the app and this fixture would silently start (or stop) redirecting every
 * spec that doesn't seed it, which looks like "the feed broke", not "the
 * fixture is stale".
 *
 * Every spec except `welcome.spec.ts` gets this seeded — by the shared
 * `context` fixture (`support/fixtures.ts`) and by `openFreshContext()` —
 * for the same reason `seedConsent` is seeded everywhere except
 * `consent.spec.ts`: this suite is about the product behind the explainer,
 * not the explainer itself. `consent.spec.ts` builds its own contexts and
 * seeds this too (see that file), since a fresh *consent* decision has
 * nothing to do with whether the device has visited before — conflating the
 * two would make every consent-banner assertion there fail against the
 * explainer instead of the page it's actually testing.
 */
import fs from "node:fs";
import path from "node:path";
import type { BrowserContext } from "@playwright/test";

const HTML_SOURCE = fs.readFileSync(path.resolve(__dirname, "../../app/+html.tsx"), "utf8");

function literal(name: string): string {
  const match = new RegExp(`var ${name} = "([^"]+)";`).exec(HTML_SOURCE);
  if (!match?.[1]) throw new Error(`could not read ${name} out of app/+html.tsx`);
  return match[1];
}

export const VISITED_STORAGE_KEY = literal("VISITED_KEY");

/** Plant the flag before the first script runs, so `/` is the feed. */
export async function seedVisited(context: BrowserContext): Promise<void> {
  await context.addInitScript((key) => {
    window.localStorage.setItem(key as string, "1");
  }, VISITED_STORAGE_KEY);
}

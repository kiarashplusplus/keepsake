/**
 * Consent helpers for the suite.
 *
 * The storage key and the version are READ OUT OF the shipped
 * `public/consent.js` rather than restated here. A hard-coded `version: 1` in
 * a test fixture is a third implementation of the codec, and the day someone
 * bumps CONSENT_VERSION every seeded context would silently start showing the
 * banner again — which, since the banner sits over the bottom of the viewport,
 * looks like "the give flow broke", not "the fixture is stale".
 */
import fs from "node:fs";
import path from "node:path";
import type { BrowserContext } from "@playwright/test";

const CONSENT_JS = fs.readFileSync(path.resolve(__dirname, "../../public/consent.js"), "utf8");

function literal(name: string, pattern: string): string {
  const match = new RegExp(`(?:var|let|const) ${name} = ${pattern};`).exec(CONSENT_JS);
  if (!match?.[1]) throw new Error(`could not read ${name} out of public/consent.js`);
  return match[1];
}

export const CONSENT_STORAGE_KEY = literal("STORAGE_KEY", "'([^']+)'");
export const CONSENT_VERSION = Number(literal("CONSENT_VERSION", "(\\d+)"));

export interface SeedConsentOptions {
  analytics?: boolean;
  advertising?: boolean;
  saleOptOut?: boolean;
  /** Write a record from a different schema version, to prove the re-prompt. */
  version?: number;
}

export function consentRecord(options: SeedConsentOptions = {}): string {
  return JSON.stringify({
    strictlyNecessary: true,
    analytics: options.analytics ?? false,
    advertising: options.advertising ?? false,
    saleOptOut: options.saleOptOut ?? true,
    gpcObserved: false,
    version: options.version ?? CONSENT_VERSION,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Plant a decision before the first script runs, so the banner never shows.
 *
 * Every spec that is not about consent gets this from the shared `context`
 * fixture. It has to be a decision rather than a suppression flag: the banner
 * showing or not is the product behaviour under test elsewhere in this file,
 * and a spec-only escape hatch would be a gate that cannot fire.
 *
 * The default is "refused everything optional", which is also what a visitor
 * who clicks Reject gets — so the rest of the suite runs against the same
 * loaded-nothing document a privacy-minded stranger sees.
 */
export async function seedConsent(context: BrowserContext, options: SeedConsentOptions = {}): Promise<void> {
  await context.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key as string, value as string);
    },
    [CONSENT_STORAGE_KEY, consentRecord(options)],
  );
}

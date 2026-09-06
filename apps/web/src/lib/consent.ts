/**
 * The app's typed view of the consent decision.
 *
 * This file DELEGATES to `window.__ksConsent`, the shared implementation
 * served as `/consent.js` (source: `apps/web/public/consent.js`) and loaded by
 * both `app/+html.tsx` and `apps/site`'s static pages. It deliberately does
 * not reimplement the codec, the storage key, or the version check.
 *
 * That rule is ported from finderly-monorepo `frontend/src/utils/consent.ts`,
 * whose header records why: a second implementation is a second thing to keep
 * in step with the consent version, and a drift there does not throw — it
 * silently re-prompts whichever surface holds the higher number, or worse,
 * silently *stops* prompting. `test/lib/consent.test.ts` runs the real
 * `/consent.js` in jsdom rather than a stand-in, so there is exactly one
 * implementation under test too.
 *
 * When the script has not loaded — the static export's Node render, a jest
 * test that never loaded it, a blocker that ate the request — every read here
 * answers "no consent" and every write is a no-op. Finderly's module chose the
 * opposite default (fall back to reading localStorage directly) because there
 * a missing module meant re-prompting a visitor who had already decided. Here
 * the script *is* the only writer, so a missing script means nothing was ever
 * stored, and denying is both correct and the safe direction.
 */

export type ConsentCategory = "strictlyNecessary" | "analytics" | "advertising";

export interface ConsentChoices {
  readonly strictlyNecessary: true;
  readonly analytics: boolean;
  readonly advertising: boolean;
  /** The CCPA/CPRA "Do Not Sell or Share" request. Sticky — see consent.js. */
  readonly saleOptOut: boolean;
  /** True when `navigator.globalPrivacyControl` was set at decision time. */
  readonly gpcObserved: boolean;
  readonly version: number;
  readonly timestamp: string;
}

export interface ConsentWrite {
  analytics: boolean;
  advertising: boolean;
  saleOptOut?: boolean;
}

interface ConsentStore {
  version: number;
  storageKey: string;
  read(): ConsentChoices | null;
  readStored(): ConsentChoices | null;
  write(partial: ConsentWrite): ConsentChoices;
  isAllowed(category: ConsentCategory): boolean;
  gpc(): boolean;
  subscribe(listener: (choices: ConsentChoices | null) => void): () => void;
  open(expanded?: boolean): void;
  close(): void;
}

function store(): ConsentStore | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { __ksConsent?: ConsentStore }).__ksConsent ?? null;
}

/**
 * The decision as ENFORCED — the stored record with a Global Privacy Control
 * signal laid over it — or null when the visitor has not answered the banner.
 *
 * This is the one to reach for. `getStoredConsent()` below is the raw record
 * and exists for display, not for gating.
 */
export function getConsent(): ConsentChoices | null {
  return store()?.read() ?? null;
}

/**
 * The record exactly as written, GPC NOT applied.
 *
 * Only for showing a visitor what they themselves chose. Never gate a load on
 * this: a grant stored before the browser started sending GPC would out-rank
 * the signal being sent right now.
 */
export function getStoredConsent(): ConsentChoices | null {
  return store()?.readStored() ?? null;
}

export function setConsent(partial: ConsentWrite): void {
  store()?.write(partial);
}

/** Whether first-party analytics may run right now. */
export function isAnalyticsAllowed(): boolean {
  return store()?.isAllowed("analytics") === true;
}

/** Whether Google Ads measurement may run right now. */
export function isAdvertisingAllowed(): boolean {
  return store()?.isAllowed("advertising") === true;
}

/** Whether the browser is sending a Global Privacy Control signal. */
export function isGpcActive(): boolean {
  return store()?.gpc() === true;
}

/** Reopen the banner with the per-category panel already expanded. */
export function openConsentBanner(): void {
  store()?.open(true);
}

export function subscribeConsent(listener: (choices: ConsentChoices | null) => void): () => void {
  const unsubscribe = store()?.subscribe(listener);
  return unsubscribe ?? ((): void => {});
}

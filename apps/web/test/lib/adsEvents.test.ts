/**
 * The conversion wrapper, driven by the REAL shared consent store.
 *
 * `@/lib/config` is mocked (its values are inlined from `EXPO_PUBLIC_*` at
 * transform time, so there is no way to set them from a test), but the gate is
 * not: `/consent.js` is evaluated in jsdom exactly as the browser gets it, and
 * `isAdvertisingAllowed()` delegates to it. That is the join this test exists
 * to prove — a wrapper that consulted a mock of the gate would pass whether or
 * not the delegation worked at all.
 */
import fs from "node:fs";
import path from "node:path";

jest.mock("@/lib/config", () => ({
  config: {
    siteUrl: "",
    turnstileSiteKey: "",
    googleAdsId: "AW-123456789",
    googleAdsGiveLabel: "giveLabel",
    googleAdsRequestLabel: "requestLabel",
    cfWebAnalyticsToken: "",
    env: "development",
  },
}));

// Static import: the module reads `config` once at load and the consent gate
// on every call, so nothing here needs a per-test module registry reset.
import { AdsConversions, trackConversion } from "@/lib/adsEvents";

const CONSENT_JS = fs.readFileSync(path.resolve(__dirname, "../../public/consent.js"), "utf8");

interface Store {
  write(partial: { analytics: boolean; advertising: boolean; saleOptOut?: boolean }): unknown;
}

function loadConsentScript(): Store {
  document.getElementById("ks-consent")?.remove();
  delete (window as unknown as { __ksConsent?: Store }).__ksConsent;
  new Function(CONSENT_JS)();
  return (window as unknown as { __ksConsent: Store }).__ksConsent;
}

type GtagCall = [string, string, Record<string, unknown>?];

function gtagCalls(): GtagCall[] {
  return (window as unknown as { __calls?: GtagCall[] }).__calls ?? [];
}

function installGtagSpy(): void {
  const calls: GtagCall[] = [];
  (window as unknown as { __calls: GtagCall[] }).__calls = calls;
  (window as unknown as { gtag: (...args: GtagCall) => void }).gtag = (...args) => {
    calls.push(args);
  };
}

beforeEach(() => {
  window.localStorage.clear();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  delete (window as unknown as { gtag?: unknown }).gtag;
  Object.defineProperty(window.navigator, "globalPrivacyControl", { value: false, configurable: true });
});

describe("trackConversion", () => {
  it("sends nothing before the visitor has decided", () => {
    loadConsentScript();
    installGtagSpy();
    expect(trackConversion(AdsConversions.GiveLive)).toBe(false);
    expect(gtagCalls()).toEqual([]);
  });

  it("sends nothing when advertising was refused", () => {
    loadConsentScript().write({ analytics: true, advertising: false });
    installGtagSpy();
    expect(trackConversion(AdsConversions.RequestSent)).toBe(false);
    expect(gtagCalls()).toEqual([]);
  });

  it("sends nothing under GPC, even with a stored grant", () => {
    loadConsentScript().write({ analytics: true, advertising: true });
    Object.defineProperty(window.navigator, "globalPrivacyControl", { value: true, configurable: true });
    loadConsentScript();
    installGtagSpy();
    expect(trackConversion(AdsConversions.GiveLive)).toBe(false);
    expect(gtagCalls()).toEqual([]);
  });

  it("sends once advertising is granted, addressed to this conversion's own action", () => {
    loadConsentScript().write({ analytics: true, advertising: true });
    installGtagSpy();

    expect(trackConversion(AdsConversions.GiveLive, { value: 1 })).toBe(true);
    expect(trackConversion(AdsConversions.RequestSent)).toBe(true);

    const sendTo = gtagCalls()
      .filter((call) => call[0] === "event" && call[1] === "conversion")
      .map((call) => call[2]?.send_to);
    // Distinct actions. Two conversions collapsing onto one label is the
    // silent failure Finderly's dataLayerEvents.ts header describes: nothing
    // errors, the numbers are simply wrong for the life of the campaign.
    expect(sendTo).toEqual(["AW-123456789/giveLabel", "AW-123456789/requestLabel"]);
    expect(new Set(sendTo).size).toBe(sendTo.length);
    expect(gtagCalls()[0]?.[2]).toMatchObject({ value: 1 });
  });

  it("sends nothing when gtag never loaded, rather than throwing", () => {
    loadConsentScript().write({ analytics: true, advertising: true });
    expect(trackConversion(AdsConversions.GiveLive)).toBe(false);
  });
});

/**
 * These tests run the REAL `apps/web/public/consent.js` in jsdom — the same
 * bytes the browser is served — rather than a TypeScript restatement of it.
 *
 * That is the whole point of the file's header: a second implementation is a
 * second thing to keep in step with CONSENT_VERSION, and a drift there does
 * not throw, it silently re-prompts (or silently stops prompting). A test that
 * asserted against a stand-in would be a third.
 *
 * Re-evaluating the script is how a page load is simulated: every loader's
 * "already injected" flag lives in the closure, so a fresh evaluation is a
 * fresh document, which is exactly what "does a reject survive a reload?"
 * needs to mean.
 */
import fs from "node:fs";
import path from "node:path";

const CONSENT_JS = fs.readFileSync(path.resolve(__dirname, "../../public/consent.js"), "utf8");
const STORAGE_KEY = "keepsake.consent.v1";

interface ConsentChoices {
  strictlyNecessary: true;
  analytics: boolean;
  advertising: boolean;
  saleOptOut: boolean;
  gpcObserved: boolean;
  version: number;
  timestamp: string;
}

interface ConsentStore {
  version: number;
  storageKey: string;
  providers: { category: string; name: string; host: string; meta: string }[];
  read(): ConsentChoices | null;
  readStored(): ConsentChoices | null;
  write(partial: { analytics: boolean; advertising: boolean; saleOptOut?: boolean }): ConsentChoices;
  isAllowed(category: string): boolean;
  gpc(): boolean;
  subscribe(listener: (choices: ConsentChoices | null) => void): () => void;
  open(expanded?: boolean): void;
  close(): void;
}

declare global {
  interface Window {
    __ksConsent?: ConsentStore;
  }
}

function setGpc(value: boolean): void {
  Object.defineProperty(window.navigator, "globalPrivacyControl", { value, configurable: true });
}

function setMeta(name: string, content: string): void {
  const meta = document.createElement("meta");
  meta.setAttribute("name", name);
  meta.setAttribute("content", content);
  document.head.appendChild(meta);
}

/**
 * Evaluate `/consent.js` against the current DOM — i.e. load the page.
 *
 * A real reload throws the document away; jsdom's does not, so the banner and
 * the stylesheet from the previous evaluation are torn down by hand. Only
 * those: the <meta> tags carrying the ids stay, because a real reload would
 * serve them again. Without this the second evaluation appends a SECOND
 * `#ks-consent`, `getElementById` keeps answering with the stale hidden one,
 * and a re-prompt looks like it did not happen.
 */
function loadPage(): ConsentStore {
  document.getElementById("ks-consent")?.remove();
  document.getElementById("ks-consent-style")?.remove();
  delete window.__ksConsent;
  new Function(CONSENT_JS)();
  const store = window.__ksConsent;
  if (!store) throw new Error("consent.js did not install window.__ksConsent");
  return store;
}

function banner(): HTMLElement | null {
  return document.getElementById("ks-consent");
}

function bannerVisible(): boolean {
  const node = banner();
  return node !== null && !node.hasAttribute("hidden");
}

function thirdPartyScripts(): string[] {
  return Array.from(document.querySelectorAll("script[src]"))
    .map((node) => node.getAttribute("src") ?? "")
    .filter((src) => /^https?:/.test(src));
}

beforeEach(() => {
  window.localStorage.clear();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  delete window.__ksConsent;
  delete (window as unknown as { dataLayer?: unknown[] }).dataLayer;
  delete (window as unknown as { gtag?: unknown }).gtag;
  setGpc(false);
});

describe("consent record", () => {
  it("defaults to no decision, and therefore to no consent for anything optional", () => {
    const store = loadPage();
    expect(store.read()).toBeNull();
    expect(store.isAllowed("analytics")).toBe(false);
    expect(store.isAllowed("advertising")).toBe(false);
    // Strictly necessary is not a choice, so it is granted with no decision on
    // file — that is the category's definition, not a leak in the gate.
    expect(store.isAllowed("strictlyNecessary")).toBe(true);
    expect(bannerVisible()).toBe(true);
  });

  it("persists a decision and stops prompting", () => {
    const store = loadPage();
    store.write({ analytics: true, advertising: true });
    expect(bannerVisible()).toBe(false);

    const reloaded = loadPage();
    expect(reloaded.read()).toMatchObject({ analytics: true, advertising: true, version: 1 });
    expect(bannerVisible()).toBe(false);
  });

  it("re-prompts when the stored version is not the current one", () => {
    const store = loadPage();
    store.write({ analytics: true, advertising: true });
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");

    // A version bump, seen from the record's side: a decision written under a
    // different schema is not a decision under this one.
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...stored, version: stored.version - 1 }));
    const reloaded = loadPage();
    expect(reloaded.read()).toBeNull();
    expect(reloaded.isAllowed("analytics")).toBe(false);
    expect(bannerVisible()).toBe(true);
  });

  it("re-prompts on a record from a NEWER version too, rather than half-trusting it", () => {
    loadPage().write({ analytics: true, advertising: true });
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...stored, version: stored.version + 1 }));
    expect(loadPage().read()).toBeNull();
  });

  it("treats unparseable storage as no decision rather than throwing", () => {
    window.localStorage.setItem(STORAGE_KEY, "accepted");
    expect(loadPage().read()).toBeNull();
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    expect(loadPage().read()).toBeNull();
  });
});

describe("Global Privacy Control", () => {
  it("refuses advertising and requests no sale/share, without being asked", () => {
    setGpc(true);
    const store = loadPage();
    store.write({ analytics: true, advertising: true });

    const record = store.read();
    expect(record?.advertising).toBe(false);
    expect(record?.saleOptOut).toBe(true);
    expect(record?.gpcObserved).toBe(true);
    // Forced at WRITE time too, not only on the way out: the record on disk
    // must not read as a grant if the browser is refusing.
    expect(store.readStored()?.advertising).toBe(false);
    expect(store.isAllowed("advertising")).toBe(false);
    // Analytics is a separate question GPC does not answer, so it is still the
    // visitor's to grant.
    expect(store.isAllowed("analytics")).toBe(true);
  });

  it("out-ranks a grant stored before the signal was turned on", () => {
    loadPage().write({ analytics: true, advertising: true });
    expect(loadPage().isAllowed("advertising")).toBe(true);

    setGpc(true);
    const store = loadPage();
    // The stored record still says what it said — nobody rewrote history.
    expect(store.readStored()?.advertising).toBe(true);
    // But what is enforced, and what every loader reads, is the refusal.
    expect(store.read()?.advertising).toBe(false);
    expect(store.read()?.saleOptOut).toBe(true);
    expect(store.isAllowed("advertising")).toBe(false);
  });

  it("says so in the UI instead of silently deciding", () => {
    setGpc(true);
    loadPage();
    const note = document.getElementById("ks-consent-gpc");
    expect(note?.hasAttribute("hidden")).toBe(false);
    expect(note?.textContent).toMatch(/Global Privacy Control/);
    // The primary button must not claim to grant something it cannot.
    expect(document.getElementById("ks-consent-accept")?.textContent).toBe("Accept analytics");
  });
});

describe("do-not-sell stickiness", () => {
  it("survives a later change to an unrelated category", () => {
    const store = loadPage();
    store.write({ analytics: true, advertising: true, saleOptOut: true });
    expect(store.read()).toMatchObject({ saleOptOut: true, advertising: false });

    // The Analytics box, toggled afterwards. It must not erase a statutory
    // request the visitor made deliberately.
    store.write({ analytics: false, advertising: true });
    expect(store.read()).toMatchObject({ saleOptOut: true, advertising: false });
  });

  it("is cleared only by an explicit false", () => {
    const store = loadPage();
    store.write({ analytics: false, advertising: false, saleOptOut: true });
    store.write({ analytics: false, advertising: true, saleOptOut: false });
    expect(store.read()).toMatchObject({ saleOptOut: false, advertising: true });
  });
});

describe("the gate", () => {
  beforeEach(() => {
    setMeta("ks-google-ads-id", "AW-123456789");
    setMeta("ks-cf-beacon-token", "beacon-token-abc");
  });

  it("loads nothing third-party before a decision", () => {
    loadPage();
    expect(thirdPartyScripts()).toEqual([]);
  });

  it("loads nothing third-party on a rejection, across a reload", () => {
    loadPage().write({ analytics: false, advertising: false });
    expect(thirdPartyScripts()).toEqual([]);
    loadPage();
    expect(thirdPartyScripts()).toEqual([]);
  });

  it("loads both only after the matching grant", () => {
    loadPage().write({ analytics: true, advertising: true });
    const sources = thirdPartyScripts();
    expect(sources.some((s) => s.includes("static.cloudflareinsights.com"))).toBe(true);
    expect(sources.some((s) => s.includes("www.googletagmanager.com"))).toBe(true);
  });

  it("keeps the categories independent", () => {
    loadPage().write({ analytics: true, advertising: false });
    const sources = thirdPartyScripts();
    expect(sources.some((s) => s.includes("static.cloudflareinsights.com"))).toBe(true);
    expect(sources.some((s) => s.includes("www.googletagmanager.com"))).toBe(false);
  });

  it("loads nothing when the ids are not configured, whatever was consented to", () => {
    document.head.innerHTML = "";
    loadPage().write({ analytics: true, advertising: true });
    expect(thirdPartyScripts()).toEqual([]);
  });

  it("treats an unsubstituted %PLACEHOLDER% as not configured", () => {
    document.head.innerHTML = "";
    setMeta("ks-google-ads-id", "%EXPO_PUBLIC_GOOGLE_ADS_ID%");
    setMeta("ks-cf-beacon-token", "%EXPO_PUBLIC_CF_WEB_ANALYTICS_TOKEN%");
    loadPage().write({ analytics: true, advertising: true });
    expect(thirdPartyScripts()).toEqual([]);
  });

  it("denies Google Consent Mode on withdrawal", () => {
    const store = loadPage();
    store.write({ analytics: true, advertising: true });
    store.write({ analytics: true, advertising: false });
    const pushes = ((window as unknown as { dataLayer: IArguments[] }).dataLayer ?? []).map((args) =>
      Array.prototype.slice.call(args),
    );
    const last = pushes.filter((p) => p[0] === "consent" && p[1] === "update").pop();
    expect(last?.[2]).toMatchObject({ ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" });
  });
});

describe("the banner", () => {
  it("offers reject and accept as the same control, one click each, reject first", () => {
    loadPage();
    const buttons = Array.from(document.querySelectorAll(".ks-consent__actions .ks-consent__btn"));
    const visible = buttons.filter((b) => b.id === "ks-consent-reject" || b.id === "ks-consent-accept");
    expect(visible.map((b) => b.id)).toEqual(["ks-consent-reject", "ks-consent-accept"]);
    // Neither is behind the "choose what to allow" panel.
    expect(document.getElementById("ks-consent-panel")?.hasAttribute("hidden")).toBe(true);
  });

  it("rejects everything optional from the reject button", () => {
    const store = loadPage();
    (document.getElementById("ks-consent-reject") as HTMLButtonElement).click();
    expect(store.read()).toMatchObject({ analytics: false, advertising: false, saleOptOut: true });
    expect(bannerVisible()).toBe(false);
  });

  it("reopens from anything carrying data-ks-consent, with the choices already open", () => {
    const store = loadPage();
    store.write({ analytics: false, advertising: false });
    expect(bannerVisible()).toBe(false);

    const link = document.createElement("button");
    link.setAttribute("data-ks-consent", "");
    document.body.appendChild(link);
    link.click();

    expect(bannerVisible()).toBe(true);
    expect(document.getElementById("ks-consent-panel")?.hasAttribute("hidden")).toBe(false);
  });

  it("is the ONLY element carrying data-ks-consent — the injected stylesheet must not collide with reopen controls", () => {
    loadPage();
    // A real bug, caught by Playwright's strict-mode locator rather than by
    // this file: the injected <style> once carried the same attribute the
    // click-delegation and CSS rule use to mean "reopen control", so
    // `document.querySelectorAll('[data-ks-consent]')` resolved to the
    // stylesheet as well as any real footer button. Since this test's DOM has
    // no footer button of its own, the only correct count is zero.
    expect(document.querySelectorAll("[data-ks-consent]")).toHaveLength(0);
    expect(document.getElementById("ks-consent-style")?.tagName).toBe("STYLE");
  });

  it("notifies subscribers", () => {
    const store = loadPage();
    const seen: (ConsentChoices | null)[] = [];
    const unsubscribe = store.subscribe((choices) => seen.push(choices));
    store.write({ analytics: true, advertising: false });
    unsubscribe();
    store.write({ analytics: false, advertising: false });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ analytics: true });
  });
});

/**
 * Guard: the published privacy policy and the code that loads third parties
 * cannot drift apart.
 *
 * `docs/runbooks/launch-audit.md` §7 found exactly that drift and called it
 * what it is — "a false factual claim in a published policy". `privacy.html`
 * asserted in the present tense that Cloudflare Web Analytics was running
 * while `src/lib/analytics.ts` was a no-op whose own header said no provider
 * was wired. Nothing failed; nothing could.
 *
 * So the shape of the fix is: `public/consent.js` carries a `PROVIDERS`
 * registry that is both the documentation and the thing that actually gates
 * the load, and this test refuses a provider the policy does not name, a host
 * the policy does not name, and any third-party URL in that file that is not
 * in the registry at all. Adding a tracker without a policy edit fails here.
 */
import fs from "node:fs";
import path from "node:path";

const WEB_ROOT = path.resolve(__dirname, "../..");
const SITE_PUBLIC = path.resolve(WEB_ROOT, "../site/public");

const CONSENT_JS = fs.readFileSync(path.join(WEB_ROOT, "public/consent.js"), "utf8");
const PRIVACY_HTML = fs.readFileSync(path.join(SITE_PUBLIC, "privacy.html"), "utf8");
/** Prose in the policy is hard-wrapped, so "Cloudflare Web Analytics" is
 * routinely split across two lines. Collapsing whitespace is what lets the
 * assertions below read the page the way a person does, without the source
 * having to be reformatted around a test. */
const PRIVACY_TEXT = PRIVACY_HTML.replace(/\s+/g, " ");

const STATIC_PAGES = ["about.html", "privacy.html", "terms.html"];

interface Provider {
  category: string;
  name: string;
  host: string;
  meta: string;
}

/** Pull the `PROVIDERS` array out of the shipped file, without importing it —
 * `consent.js` is an IIFE that expects a DOM, and this test only wants its
 * declared surface. */
function providers(): Provider[] {
  const block = /(?:var|let|const) PROVIDERS = \[([\s\S]*?)\n {2}\];/.exec(CONSENT_JS);
  if (!block?.[1]) throw new Error("could not find the PROVIDERS array in public/consent.js");
  const found: Provider[] = [];
  for (const entry of block[1].split(/\}\s*,?\s*\{/)) {
    const field = (name: string): string => new RegExp(`${name}:\\s*'([^']+)'`).exec(entry)?.[1] ?? "";
    const provider = { category: field("category"), name: field("name"), host: field("host"), meta: field("meta") };
    if (provider.name) found.push(provider);
  }
  return found;
}

describe("privacy policy vs. the code", () => {
  const declared = providers();

  it("finds the provider registry (positive control)", () => {
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.map((p) => p.category).sort()).toEqual(["advertising", "analytics"]);
  });

  it.each(declared)("privacy.html names $name and $host", ({ name, host }) => {
    expect(PRIVACY_TEXT).toContain(name);
    expect(PRIVACY_TEXT).toContain(host);
  });

  it("has no third-party URL in consent.js that the registry does not declare", () => {
    const hosts = new Set(declared.map((p) => p.host));
    const used = [...CONSENT_JS.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)].map((m) => m[1] ?? "");
    const undeclared = [...new Set(used)].filter((host) => !hosts.has(host));
    expect(undeclared).toEqual([]);
  });

  it("no longer claims analytics is running as a present-tense fact", () => {
    // The exact sentence the launch audit flagged.
    expect(PRIVACY_TEXT).not.toContain("We use Cloudflare Web Analytics");
  });

  it("states the gate, the withdrawal route, and the GPC position", () => {
    expect(PRIVACY_TEXT).toContain("Global Privacy Control");
    expect(PRIVACY_TEXT).toContain("do not sell or share");
    expect(PRIVACY_TEXT).toContain("Privacy choices");
  });

  it.each(STATIC_PAGES)("%s loads the one shared consent implementation", (page) => {
    const html = fs.readFileSync(path.join(SITE_PUBLIC, page), "utf8");
    expect(html).toContain('<script src="/consent.js"');
    // Reopening the choice has to be possible from every page, not just the
    // one that happens to describe it.
    expect(html).toContain("data-ks-consent");
    for (const { meta } of declared) {
      expect(html).toContain(`<meta name="${meta}"`);
    }
  });

  it("has exactly one consent implementation in the repo", () => {
    // A second copy is the failure mode this whole design exists to avoid:
    // Finderly kept two banner templates and two copies of its store, and they
    // drifted in ways that did not throw.
    const roots = [path.join(WEB_ROOT, "public"), SITE_PUBLIC, path.join(WEB_ROOT, "src")];
    const copies: string[] = [];
    for (const root of roots) {
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const child = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(child);
          else if (/\.(js|ts|tsx)$/.test(entry.name) && fs.readFileSync(child, "utf8").includes("keepsake.consent.v1")) {
            copies.push(path.relative(WEB_ROOT, child));
          }
        }
      };
      walk(root);
    }
    expect(copies).toEqual(["public/consent.js"]);
  });
});

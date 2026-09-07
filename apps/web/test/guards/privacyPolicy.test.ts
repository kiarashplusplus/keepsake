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
 *
 * Issue #88 extends the same idea to the Worker's AI calls, because the same
 * drift had happened again quietly: `apps/api/src/suggest/suggest.ts` is a
 * vision call that reads an uploaded photo and hands back a title, a
 * category, tags and a description of the object, and the policy's only AI
 * paragraph described safety screening. A reader was told their photo goes
 * to a model to keep the marketplace safe and not told it also goes to a
 * model to be described back as listing content. Purpose is the thing a
 * privacy notice exists to state, so the second block below enumerates every
 * `AI.run(...)` site under `apps/api/src` and fails for one the policy does
 * not disclose — and, for the suggestion call, for any *field* the model
 * produces that the policy does not account for.
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

const API_SRC = path.resolve(WEB_ROOT, "../api/src");
const SUGGESTION_CONTRACT = path.resolve(WEB_ROOT, "../../packages/contracts/src/photo.ts");

interface AiCallSite {
  /** Path under `apps/api/src`, the same string the walk below produces. */
  file: string;
  /** What this model is asked to do — the thing a reader needs told. */
  purpose: string;
  /** Substrings that must survive in privacy.html for the purpose to count
   * as disclosed. Prose, not markup: `PRIVACY_TEXT` is whitespace-collapsed
   * so a hard-wrapped sentence still matches. */
  discloses: string[];
}

const AI_CALL_SITES: AiCallSite[] = [
  {
    file: "moderation/text.ts",
    purpose: "safety screening of a listing's words",
    discloses: ["Every listing's text", "checked automatically by AI models"],
  },
  {
    file: "moderation/image.ts",
    purpose: "safety screening of an uploaded photo",
    discloses: ["photos are checked automatically by AI models", "to keep the marketplace safe"],
  },
  {
    file: "suggest/suggest.ts",
    purpose: "autofill: reading a photo to fill in the give form",
    discloses: [
      "read by an AI vision model",
      // The disclosure has to say this is *not* the safety pipeline. Two
      // calls with two purposes, and one paragraph covering both would be
      // the same omission in a different shape.
      "a separate call from the safety screening",
    ],
  },
  {
    file: "search/embedding.ts",
    purpose: "semantic search: embedding a listing's words, and a search query",
    discloses: [
      "into a list of numbers that",
      // The policy must say what is sent, not just that a model is called —
      // "only the words already public on the listing" is the whole claim.
      "Only your listing's own public words are",
      // And it must not imply this is running while SEMANTIC_SEARCH is off
      // in every environment. When the flag is flipped, this phrase is
      // removed from the policy and from here, together — see step 5 of
      // "Vectorize (issue #38)" in docs/runbooks/deploy.md.
      "switched off today and is not running",
    ],
  },
];

/** Which sentence in the policy accounts for each field the suggestion model
 * produces (`PhotoSuggestionSchema`). A new field — "estimated value", say —
 * fails the build until the policy says what it is and whether it's kept. */
const SUGGESTION_FIELD_DISCLOSURES: Record<string, string> = {
  subject: "a plain description of what it sees",
  title: "proposes a title",
  category: "picks a category",
  condition: "one line about visible wear",
  aspects: "suggests a handful of short tags",
};

/** Every file under `apps/api/src` that calls Workers AI, relative to that
 * directory. Deliberately a filesystem walk and not a hand-maintained list:
 * a hand-maintained list is what `AI_CALL_SITES` is, and the whole point is
 * to catch the day the two disagree. */
function aiCallSiteFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else if (/\.ts$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name)) {
        if (/\bAI\.run\s*\(/.test(fs.readFileSync(child, "utf8"))) {
          found.push(path.relative(API_SRC, child).split(path.sep).join("/"));
        }
      }
    }
  };
  walk(API_SRC);
  return found.sort();
}

/** Top-level field names of `PhotoSuggestionSchema` — what the vision model
 * is actually asked to produce. */
function suggestionFields(): string[] {
  const source = fs.readFileSync(SUGGESTION_CONTRACT, "utf8");
  const block = /export const PhotoSuggestionSchema = z\.object\(\{([\s\S]*?)\n\}\);/.exec(source);
  if (!block?.[1]) throw new Error("could not find PhotoSuggestionSchema in packages/contracts/src/photo.ts");
  // Two-space indent is what makes a key top-level inside the object
  // literal; nested schemas (`AspectSchema`'s own fields) sit deeper. Not
  // anchored to `z.` because `category` is `CategorySchema`, imported.
  return [...block[1].matchAll(/^ {2}(\w+):\s*\S/gm)].map((m) => m[1] ?? "").sort();
}

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

describe("privacy policy vs. the Worker's AI calls (#88)", () => {
  const found = aiCallSiteFiles();

  it("finds the AI call sites (positive control)", () => {
    // If this walk ever returns nothing, every assertion below would pass
    // vacuously — which is precisely how the five checks in AGENTS.md's
    // table came to be worthless.
    expect(found.length).toBeGreaterThan(0);
  });

  it("has a disclosure registered for every AI call in apps/api/src", () => {
    expect(found).toEqual(AI_CALL_SITES.map((site) => site.file).sort());
  });

  it.each(AI_CALL_SITES)("privacy.html discloses $file ($purpose)", ({ discloses }) => {
    for (const phrase of discloses) {
      expect(PRIVACY_TEXT).toContain(phrase);
    }
  });

  it("has a disclosure registered for every field the suggestion model produces", () => {
    const fields = suggestionFields();
    expect(fields.length).toBeGreaterThan(0);
    expect(fields).toEqual(Object.keys(SUGGESTION_FIELD_DISCLOSURES).sort());
  });

  it.each(Object.entries(SUGGESTION_FIELD_DISCLOSURES))("privacy.html says what happens to the suggestion's %s", (_field, phrase) => {
    expect(PRIVACY_TEXT).toContain(phrase);
  });

  it("says what is kept of the suggestion, not only that a model was involved", () => {
    // The two halves that matter to a reader: what is stored on the listing
    // (title, category and the tags — issue #36 persists those to
    // `listing_aspects`, and the browse page groups by them), and what is
    // not.
    expect(PRIVACY_TEXT).toContain("saved");
    expect(PRIVACY_TEXT).toContain("with your listing as ordinary listing content");
    expect(PRIVACY_TEXT).toContain("anything you type over it wins");
    expect(PRIVACY_TEXT).toContain("never reach our records");
  });
});

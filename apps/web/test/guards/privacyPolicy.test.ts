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
const AGE_GATE_DIR = path.resolve(WEB_ROOT, "src/features/ageGate");
const LISTINGS_ROUTE = path.join(API_SRC, "routes/listings.ts");
const ME_ROUTE = path.join(API_SRC, "routes/me.ts");
const ORPHAN_SWEEP = path.join(API_SRC, "cron/orphanSweep.ts");
const MIGRATIONS = path.resolve(WEB_ROOT, "../api/migrations");
const EMAIL_SCREEN = path.join(WEB_ROOT, "app/mine/email.tsx");

/**
 * Every `<h2>` on the page, in source order. The list is the point: the two
 * drifts this file was written for (#87, #88) were both a *paragraph* going
 * stale, and the guards caught them only once someone thought to name the
 * sentence. A whole section being deleted — the Rhode Island disclosure, the
 * rights section — would have sailed through every assertion above it,
 * because a phrase that isn't on the page can't be asserted about unless
 * something already insists the page has that heading at all. Exact equality,
 * not a subset: adding a section to a privacy policy is also a thing that
 * should require someone to look at this file.
 */
const EXPECTED_SECTIONS = [
  "Who runs this",
  "No accounts, just a device key",
  "An optional email",
  "What a requester shares",
  "Photos",
  "Location",
  "Screening",
  "Autofill from your photo",
  "Rate limiting",
  "Your choice, before anything loads",
  "Changing your mind",
  "Global Privacy Control",
  "We don't sell or share data",
  "Categories of information we collect",
  "Your rights: access, deletion, and portability",
  "Minimum age",
  "Other services we rely on",
  "What changed",
  "Questions",
];

/**
 * The four passages issues #60/#61/#62 put on the page and then left
 * unguarded. Each one is a claim about the world that some specific code or
 * some specific statute is behind; a rewrite that loses it is the same class
 * of failure as #87's overclaimed hash, just in a section nobody happened to
 * be editing that day.
 */
const LOCKED_PASSAGES: { name: string; phrases: string[] }[] = [
  {
    // RIDTPPA §6-48.1-3(a) asks for three things in a *designated* section:
    // the categories collected, who the information is sold to, and a named
    // controller. All three, or the section stops doing its job — see
    // docs/legal-open-questions-research.md "Q3 — Rhode Island".
    name: "Rhode Island's RIDTPPA disclosure (#60)",
    phrases: [
      "a device-generated identifier (your device key)",
      "an optional email address",
      "We don't sell any of it, to anyone, for any reason",
      "is the controller for all of it",
    ],
  },
  {
    // #62: `CreateListingInput` has no lat/lng field at all — a listing's
    // point comes from the `postal_codes` table. The sentence is precise on
    // purpose and the precision is the whole disclosure.
    name: "location precision (#62)",
    phrases: [
      "a postcode centroid, not a device-precise coordinate",
      "we only ever receive the postcode it hands back, never the coordinates",
    ],
  },
  {
    // #60 again: deletion alone was what the page used to offer. Access and
    // portability are separate rights and have to be named as such.
    name: "access and portability rights (#60)",
    phrases: [
      "Your rights: access, deletion, and portability",
      "seeing a copy of what we hold about you (access)",
      "getting it in a portable form",
    ],
  },
  {
    // #61: the commitment is a *specific* action, because "we'll remove the
    // account" was both vague and contradicted the page's own "no accounts".
    // `POST /admin/owners/:id/ban` is the code behind the second half.
    name: "minor takedown on actual knowledge (#61)",
    phrases: [
      "the moment we actually learn",
      "that someone using Keepsake is a minor",
      "banning the device key that posted it",
    ],
  },
];

/** `<h2>` text in source order, whitespace-collapsed the same way
 * `PRIVACY_TEXT` is. */
function sections(): string[] {
  return [...PRIVACY_HTML.matchAll(/<h2>([\s\S]*?)<\/h2>/g)].map((m) => (m[1] ?? "").replace(/\s+/g, " ").trim());
}

/** Source with `//` and block comments removed, so an assertion about what
 * the *code* does isn't satisfied (or defeated) by a doc comment that talks
 * about it. `listings.ts` mentions `input.date_of_birth` twice in prose
 * explaining that it is never bound — which is exactly the claim under
 * test, so the prose has to go before the test can mean anything. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Files under a directory, recursively. */
function filesUnder(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) walk(child);
      else found.push(child);
    }
  };
  walk(dir);
  return found;
}

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
      // SEMANTIC_SEARCH was flipped to "1" in every deployed environment on
      // 2026-09-07, so the policy's previous "switched off today and is not
      // running" sentence became false and was replaced. The policy had
      // promised in its own words to come back and change that paragraph
      // rather than leave it stale, which is what this pair of assertions
      // now holds it to.
      "This is running",
      // Switching it on created something the earlier version had nothing to
      // disclose: a stored derivative of the listing that outlives the
      // request. The policy has to say it is stored, what it is stored
      // beside, and that deleting the listing deletes it.
      "stored with Cloudflare",
      "Delete your listing and it is deleted too",
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

describe("privacy policy structure", () => {
  it("has every section it is supposed to have, and no others", () => {
    expect(sections()).toEqual(EXPECTED_SECTIONS);
  });

  it.each(LOCKED_PASSAGES)("privacy.html still carries $name", ({ phrases }) => {
    for (const phrase of phrases) {
      expect(PRIVACY_TEXT).toContain(phrase);
    }
  });

  it("carries a dated record of what changed, dated the same day as the header", () => {
    // A hand-written "Last updated" with nothing behind it is what the page
    // had; a reader could see that something moved and never find out what.
    expect(PRIVACY_HTML).toContain('<section id="changes">');
    const updated = /Last updated (\d{1,2} [A-Z][a-z]+ \d{4})/.exec(PRIVACY_TEXT)?.[1];
    expect(updated).toBeDefined();
    // The newest entry is the day the page was last touched — if the two
    // disagree, one of them is lying about when.
    const entries = [...PRIVACY_TEXT.matchAll(/<strong>(\d{1,2} [A-Z][a-z]+ \d{4})\.<\/strong>/g)].map((m) => m[1] ?? "");
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]).toBe(updated);
  });
});

/**
 * The age gate (issue #64). The checkbox left the product in 669ca7f and the
 * policy went on describing one — the same failure as #87 and #88, in a
 * section nobody happened to be editing. So the wording is pinned to the code
 * that replaced it, and the factual claim that wording now makes ("checked,
 * then discarded") is pinned to the code that has to stay true for it.
 */
describe("privacy policy vs. the age gate (#64)", () => {
  const ageGateFiles = fs.existsSync(AGE_GATE_DIR) ? filesUnder(AGE_GATE_DIR) : [];

  it("finds the shared age-gate component (positive control)", () => {
    // Without this, everything below is conditional on a directory that could
    // quietly vanish — the vacuous-pass shape AGENTS.md warns about.
    expect(ageGateFiles.map((file) => path.basename(file))).toContain("AgeGateField.tsx");
  });

  it("describes a date of birth, because that is what the field asks for", () => {
    const asksForDob = ageGateFiles.some((file) => fs.readFileSync(file, "utf8").includes("DateOfBirthSchema"));
    expect(asksForDob).toBe(true);
    expect(PRIVACY_TEXT).toContain("your date of birth");
  });

  it("no longer describes the gate as a box you tick", () => {
    // The exact wording that outlived the code: "asks everyone posting or
    // requesting a keepsake to confirm they're 18 or older".
    expect(PRIVACY_TEXT).not.toMatch(/confirm (they|you)'re 18/);
    expect(PRIVACY_TEXT).toContain("doesn't ask you to tick a box");
  });

  it("says the date is discarded, and no migration adds a column that would make that false", () => {
    expect(PRIVACY_TEXT).toContain("No column in our database holds a date of birth");
    const offending = filesUnder(MIGRATIONS).filter(
      (file) => file.endsWith(".sql") && fs.readFileSync(file, "utf8").includes("date_of_birth"),
    );
    expect(offending).toEqual([]);
  });

  it("writes only the timestamp, never the date itself, on create", () => {
    // `age_attested_at` is the whole of what the policy promises is kept. Any
    // other use of the submitted date in this route — binding it into the
    // INSERT, say — turns that paragraph into a false statement.
    const code = withoutComments(fs.readFileSync(LISTINGS_ROUTE, "utf8"));
    const uses = code.split("\n").filter((line) => line.includes("date_of_birth"));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      expect(line).toMatch(/date_of_birth\s*\?\s*now\s*:\s*null/);
    }
  });
});

/**
 * Email retention (issue #60). The posture is deliberate — an address is the
 * only way back to a listing once a device key is gone, so no dormancy timer
 * removes it — and the page states it without hedging. Two things have to
 * hold for that to stay true: nothing in the sweep starts collecting rows
 * that still carry an address, and the self-service control the page sends
 * people to keeps existing.
 */
describe("privacy policy vs. how long an email is kept (#60)", () => {
  it("keeps addresses indefinitely, and says so, because the sweep exempts them", () => {
    // `sweepEmptyOwners` only ever collects an owner row with no address on
    // it. The day that changes, the paragraph becomes untrue and this is the
    // line that notices.
    //
    // Comment-stripped, and that is not a nicety: the first draft of this
    // asserted against the raw file, and deleting `AND email IS NULL` from
    // the DELETE left the guard green, because a doc comment eight lines up
    // quotes the same clause. A guard that a comment can satisfy is the
    // vacuous pass this file exists to prevent, caught only by breaking it
    // on purpose.
    expect(withoutComments(fs.readFileSync(ORPHAN_SWEEP, "utf8"))).toContain("email IS NULL");
    expect(PRIVACY_TEXT).toContain("we keep it indefinitely");
    expect(PRIVACY_TEXT).toContain("no dormancy window, no inactivity timer, and no cleanup job that removes it");
  });

  it("points at the self-service control that actually exists", () => {
    // `app/mine/email.tsx`'s Remove button calls `DELETE /api/me/email`,
    // which nulls the column outright. The page used to send people to the
    // inbox for this, which was simply wrong.
    expect(fs.existsSync(EMAIL_SCREEN)).toBe(true);
    expect(fs.readFileSync(EMAIL_SCREEN, "utf8")).toContain('label="Remove"');
    expect(withoutComments(fs.readFileSync(ME_ROUTE, "utf8"))).toContain('meRoutes.delete("/email"');
    expect(PRIVACY_TEXT).toContain('href="/mine/email"');
  });
});

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
/**
 * Every write path that binds `date_of_birth`. #306: the guard below used to
 * scan `LISTINGS_ROUTE` alone — the *request* creation path — while the
 * *listing* creation path (`listings/create.ts`) feeds the same input into
 * two more `INSERT INTO listings` statements from a different file, unscanned
 * and unproven. A list, not a second constant, so a third write path
 * introduced later fails loudly instead of joining the unguarded set.
 */
const DATE_OF_BIRTH_WRITE_PATHS = [LISTINGS_ROUTE, path.join(API_SRC, "listings/create.ts")];
const ME_ROUTE = path.join(API_SRC, "routes/me.ts");
const RECOVER_ROUTE = path.join(API_SRC, "routes/recover.ts");
const ORPHAN_SWEEP = path.join(API_SRC, "cron/orphanSweep.ts");
const REQUEST_WITHDRAW_ROUTE = path.join(API_SRC, "routes/requestWithdraw.ts");
const BUDGET = path.join(API_SRC, "moderation/budget.ts");
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
  "No password, just a device key",
  "Your email",
  "What a requester shares",
  "Photos",
  "Location",
  "Screening",
  "Autofill from your photo",
  "Search by meaning",
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
      "an email address",
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
    // account" was both vague and named a thing this product doesn't have.
    // `POST /admin/owners/:id/ban` is the code behind the second half.
    name: "minor takedown on actual knowledge (#61)",
    phrases: [
      "the moment we actually learn",
      "that someone using Keepsake is a minor",
      "banning the device key that posted it",
    ],
  },
  {
    // #108: the entity question behind this section was decided, and decided
    // as "no entity" — a sole proprietorship, so every disclaimer on this
    // site protects a person rather than a company. The accountability point
    // that PIPEDA Sched. 1 cl. 4.8 and RIDTPPA §6-48.1-3(a) both want is
    // served by naming that person in full, and the decision to keep his home
    // address off a public page (docs/legal-entity-and-insurance.md, "Where
    // the address goes") is only defensible while the page still says how to
    // get one for a legal notice. Dropping either half is a substantive
    // change to a compliance posture, not a copy edit.
    name: "the named individual controller and the address on request (#108)",
    phrases: [
      "Kiarash Adl, operating as an individual",
      "not through a company or any other entity",
      "If you need a postal address for a legal notice",
    ],
  },
];

/** `<h2>` text in source order, whitespace-collapsed the same way
 * `PRIVACY_TEXT` is. */
function sections(): string[] {
  // `(?:\s+[^>]*)?` tolerates an `id="..."` (or other attribute) on the tag —
  // #312 added `id="requester-shares"` so terms.html can link straight to
  // the canonical withdraw explanation — without this the heading would
  // simply not match and silently drop out of the list below.
  return [...PRIVACY_HTML.matchAll(/<h2(?:\s+[^>]*)?>([\s\S]*?)<\/h2>/g)].map((m) => (m[1] ?? "").replace(/\s+/g, " ").trim());
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
  // #135. `markings` is the model's verbatim read of any lettering on the
  // object, and like `subject` it is never persisted — but it is read off a
  // photo of someone's possession, so a policy that lists every other field
  // and silently omits this one is the same drift #88 was written for.
  markings: "copies out any words printed on the object itself",
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
  /** Where the tag reports, when that is a different origin from where it is
   * fetched. Optional: a provider that has not needed one has "". */
  beacon: string;
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
    const provider = {
      category: field("category"),
      name: field("name"),
      host: field("host"),
      meta: field("meta"),
      beacon: field("beacon"),
    };
    if (provider.name) found.push(provider);
  }
  return found;
}

interface CategoryRow {
  id: string;
  name: string;
  disabled: boolean;
  description: string;
}

/**
 * Every `categoryRow(...)` call in `consent.js`, in source order. Reads the
 * FOURTH argument — the human-readable description a visitor actually reads
 * before deciding — which `providers()` above never looks at: that parser
 * only sees `PROVIDERS`' `name` / `host` / `beacon` fields. Issue #299 was
 * the consequence: the banner told every visitor "Google Ads measurement, so
 * we can tell which advert brought you here" — present tense, for a tag that
 * has never loaded on any published build — and the one guard written for
 * exactly this drift class (#175) was structurally blind to this file,
 * because nothing here parsed this string.
 */
function categoryRows(): CategoryRow[] {
  const found: CategoryRow[] = [];
  const re = /categoryRow\(\s*'([^']*)',\s*'([^']*)',\s*(true|false),\s*'([^']*)'\s*\)/g;
  for (const m of CONSENT_JS.matchAll(re)) {
    found.push({ id: m[1] ?? "", name: m[2] ?? "", disabled: m[3] === "true", description: m[4] ?? "" });
  }
  return found;
}

describe("privacy policy vs. the code", () => {
  const declared = providers();

  it("finds the provider registry (positive control)", () => {
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.map((p) => p.category).sort()).toEqual(["advertising", "analytics"]);
  });

  it("finds the category rows (positive control)", () => {
    // Without this, the assertion below would pass vacuously against a
    // banner that had lost its categoryRow(...) calls entirely.
    expect(categoryRows().length).toBeGreaterThan(0);
  });

  it("no category description names a provider that has shipped with no loadable id (#299)", () => {
    // A provider is DECLARED DEAD when its meta ships a literal, hardcoded
    // `content=""` — the kill switch #175 put in place for Google Ads — as
    // opposed to an unsubstituted `%EXPO_PUBLIC_*%` build-time placeholder,
    // which may resolve to a real id once a deploy fills it in (Cloudflare
    // Web Analytics ships that way, and its category description is allowed
    // to describe it as live because it can become live). For a provider
    // that is declared dead, the banner's own description of that category
    // must not name it — naming a dead provider in a live-sounding
    // description is exactly the #299 drift, and this is what makes that
    // drift fail a test instead of only a launch-audit pass.
    for (const provider of declared) {
      const metaTag = new RegExp(`<meta name="${provider.meta}" content="([^"]*)"`).exec(PRIVACY_HTML);
      const isDeclaredDead = metaTag?.[1] === "";
      if (!isDeclaredDead) continue;
      const row = categoryRows().find((r) => r.id === `ks-consent-${provider.category}`);
      expect(row).toBeDefined();
      expect(row?.description).not.toContain(provider.name);
    }
  });

  it.each(declared)("privacy.html names $name and $host", ({ name, host }) => {
    expect(PRIVACY_TEXT).toContain(name);
    expect(PRIVACY_TEXT).toContain(host);
  });

  it.each(declared.filter((p) => p.beacon))(
    "privacy.html names where $name sends what it collects, not just where it is loaded from",
    ({ beacon }) => {
      // The origin a tag *reports* to is the one that receives the data, so it
      // is the one a reader of this policy actually needs. It is a different
      // origin from the script host for Cloudflare Web Analytics, and naming
      // only the script host would describe the fetch and hide the recipient.
      //
      // Matched as a whole hostname rather than with `toContain`, which was
      // this assertion's first form and was vacuous: `cloudflareinsights.com`
      // is a substring of `static.cloudflareinsights.com`, so deleting the
      // recipient from the policy still passed.
      const hostname = new URL(beacon).hostname;
      const whole = new RegExp(`(?<![\\w.])${hostname.replace(/\./g, "\\.")}(?![\\w.])`);
      expect(PRIVACY_TEXT).toMatch(whole);
    },
  );

  it("has no third-party URL in consent.js that the registry does not declare", () => {
    const hosts = new Set(declared.flatMap((p) => (p.beacon ? [p.host, new URL(p.beacon).hostname] : [p.host])));
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

  it("no longer describes the date-of-birth field as one you type (#302)", () => {
    // Since #133 the control is a real date picker (`ui/DateField`, a DOM
    // `<input type="date">` on the web) — the system wheel on iOS, the
    // system calendar on desktop — not a text box someone types
    // `1990-12-12` into. "YYYY-MM-DD" is still the wire format
    // `DateOfBirthSchema` validates, so that half is true of the *data*;
    // "typed as ..." described the user's *action*, and that action is
    // gone. Pinning the word rather than a whole sentence, because a
    // picker also lets desktop users type into segmented fields, so
    // describing the *new* widget would be just as overspecified as the
    // old wording was.
    expect(PRIVACY_TEXT).not.toMatch(/\btyped as\b/);
    expect(PRIVACY_TEXT).not.toMatch(/\ba date you type\b/);
    expect(PRIVACY_TEXT).toContain("your date of birth");
  });

  it("says the date is discarded, and no migration adds a column that would make that false", () => {
    expect(PRIVACY_TEXT).toContain("No column in our database holds a date of birth");
    const offending = filesUnder(MIGRATIONS).filter(
      (file) => file.endsWith(".sql") && fs.readFileSync(file, "utf8").includes("date_of_birth"),
    );
    expect(offending).toEqual([]);
  });

  it.each(DATE_OF_BIRTH_WRITE_PATHS)("writes only the timestamp, never the date itself, on create (%s)", (file) => {
    // `age_attested_at` is the whole of what the policy promises is kept. Any
    // other use of the submitted date in this file — binding it into the
    // INSERT, say — turns that paragraph into a false statement. Both the
    // request path (`routes/listings.ts`) and the listing path
    // (`listings/create.ts`) make this claim, so both are held to it (#306).
    const code = withoutComments(fs.readFileSync(file, "utf8"));
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

/**
 * IP-hash retention (issue #169). The page promises, in two places, that a
 * hashed IP expires after 48 hours. That was true of the KV budget counters
 * and false of the two D1 columns holding the *same* value —
 * `requests.ip_digest` and `reports.ip_digest` had no TTL, no sweep and no
 * delete path, and the requester's own withdraw link left the hash behind.
 * The fourth false claim this page has shipped (after #87, #88, #112), and
 * the first that is a retention promise.
 *
 * The audit that found it demonstrated why this block has to exist: changing
 * `budget.ts`'s `TTL_SECONDS` from 48 hours to 100 days broke **nothing** in
 * the whole API suite, and this file — which already locks the analytics, AI
 * and Rhode Island passages — had no assertion mentioning retention at all.
 * So the number is locked from both ends here, the way the Rhode Island
 * passages are: the sentence on the page, and each of the three mechanisms
 * that has to hold for the sentence to be true.
 */
describe("privacy policy vs. how long a hashed IP is kept (#169)", () => {
  /** 48 hours, as the page states it, in each unit the code expresses it in. */
  const HOURS = 48;

  it("says 48 hours on the page, in both places that make the promise", () => {
    // `PRIVACY_TEXT` is whitespace-collapsed, so the hard wrap inside "48\n
    // hours" still matches — the sentence the audit quoted is split across
    // lines in the source.
    expect(PRIVACY_TEXT).toContain(`We keep each day's hash for ${HOURS} hours, then it expires automatically`);
    expect(PRIVACY_TEXT).toContain(`Hashes of your IP address expire automatically after ${HOURS} hours`);
    // And that the promise is explicitly about every copy, not only the
    // counters — the exact gap between the old sentence and the code.
    expect(PRIVACY_TEXT).toContain(`The ${HOURS} hours covers every copy, not just the counters`);
  });

  it("expires the KV counters at that number", () => {
    // The one mechanism that was always real. Comment-stripped for the same
    // reason the #60 block is: the line's own trailing comment says "48
    // hours", so an assertion against the raw file would pass on a changed
    // constant with a stale comment beside it.
    const code = withoutComments(fs.readFileSync(BUDGET, "utf8"));
    expect(code).toContain(`const TTL_SECONDS = ${(HOURS * 60 * 60).toString().replace(/^(\d+)(\d{3})$/, "$1_$2")};`);
  });

  it("sweeps the D1 copies at that number, on both tables", () => {
    const code = withoutComments(fs.readFileSync(ORPHAN_SWEEP, "utf8"));
    // The window itself...
    expect(code).toContain(`const IP_DIGEST_RETENTION_MS = ${HOURS} * 60 * 60 * 1000;`);
    // ...and the two statements that apply it. Deleting either leaves one
    // table's hashes in place forever, which is the state #169 found.
    expect(code).toContain("UPDATE requests SET ip_digest = NULL");
    expect(code).toContain("UPDATE reports SET ip_digest = NULL");
    // ...and that the sweep is actually wired into the nightly run rather
    // than defined and never called — the shape of the rate limiter in
    // AGENTS.md's table that was declared everywhere and called from nowhere.
    expect(code).toContain("await sweepExpiredIpDigests(");
    expect(code).toContain("IP_DIGEST_RETENTION_MS,");
  });

  it("erases the hash on withdrawal, not just the note and the contact details", () => {
    // `POST /api/requests/withdraw` is the only control a requester has over
    // their own data — they have no device token and no dashboard. It nulled
    // note/email/phone and left `ip_digest`, which is what made "we removed
    // your information" not quite true.
    const code = withoutComments(fs.readFileSync(REQUEST_WITHDRAW_ROUTE, "utf8"));
    expect(code).toMatch(/UPDATE requests SET[^`]*ip_digest = NULL/);
  });

  it("has no migration that reintroduces a NOT NULL on either ip_digest column", () => {
    // The sweep cannot null a column the schema forbids nulling. A later
    // migration rebuilding either table with `ip_digest TEXT NOT NULL` would
    // make every nightly sweep throw and the page false again — so what is
    // asserted is the *newest* definition of each table, not merely that some
    // migration once dropped the constraint.
    const migrations = filesUnder(MIGRATIONS)
      .filter((file) => file.endsWith(".sql"))
      .sort();
    expect(migrations.length).toBeGreaterThan(0);
    for (const table of ["requests", "reports"]) {
      const definitions = migrations
        .map((file) => new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\);`).exec(fs.readFileSync(file, "utf8"))?.[1])
        .filter((body): body is string => body !== undefined);
      expect(definitions.length).toBeGreaterThan(0);
      const newest = definitions[definitions.length - 1] ?? "";
      expect(newest).toContain("ip_digest");
      expect(newest).not.toMatch(/ip_digest\s+TEXT\s+NOT NULL/);
    }
  });
});

/**
 * Emailed-link lifetimes. The page states two of them in one sentence — 24
 * hours for a verify link, an hour for a recovery link — and both are
 * retention promises in the same sense as the hashed IP above: they say how
 * long a token that reaches someone's inbox stays usable.
 *
 * The recovery number is why this block exists. `RECOVER_TTL_MS` was raised
 * from 30 minutes to an hour on 2026-09-07, and the change was careful about
 * the copy it knew about: the recovery *email* had carried its own literal
 * "30 minutes" one module away from the constant, so the template was made to
 * take the TTL as a parameter and `apps/api/test/email.test.ts` holds the two
 * together. The privacy page's copy of the same number was in neither place
 * and nothing pointed at it, so it went on saying 30 minutes for a day. Same
 * failure as #87/#88/#169 — a sentence going stale in a section nobody was
 * editing — and the same fix: assert the page from one end and the constant
 * from the other.
 */
describe("privacy policy vs. how long an emailed link lives", () => {
  it("states both lifetimes in the sentence that makes the promise", () => {
    expect(PRIVACY_TEXT).toContain("expires in 24 hours (or an hour for a recovery link)");
  });

  it("mints a recovery token for exactly the hour the page promises", () => {
    // Comment-stripped: the constant's own doc comment narrates the 30-to-60
    // change in words, so an assertion against the raw file would match the
    // prose describing a number rather than the number.
    const code = withoutComments(fs.readFileSync(RECOVER_ROUTE, "utf8"));
    expect(code).toContain("export const RECOVER_TTL_MS = 60 * 60 * 1000;");
    // And that the constant is what the mint actually uses — a TTL defined
    // and then not applied is the declared-everywhere-called-from-nowhere
    // shape AGENTS.md's table warns about.
    expect(code).toContain("now + RECOVER_TTL_MS");
  });

  it("mints a verify-email token for exactly the 24 hours the page promises", () => {
    const code = withoutComments(fs.readFileSync(ME_ROUTE, "utf8"));
    expect(code).toContain("const VERIFY_EMAIL_TTL_MS = 24 * 60 * 60 * 1000;");
    expect(code).toContain("now + VERIFY_EMAIL_TTL_MS");
  });

  it("clears the spent token record within the further week it promises", () => {
    const code = withoutComments(fs.readFileSync(ORPHAN_SWEEP, "utf8"));
    expect(code).toContain("const RECOVERY_TOKEN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;");
  });
});

/**
 * The advertising group (#175). This is the inverse of the drift the top of
 * this file was written for, and it is worth guarding for the same reason.
 *
 * `#88` and `#112` were the page claiming something the code did not do.
 * Here the page claimed something the code *could not* do: "Advertising"
 * described, in the present tense, a Google Ads tag loading on consent and
 * Google receiving something — while `ks-google-ads-id` is hardcoded empty on
 * every page, `config.ts`'s readers are deleted, and `consent.js` fails its
 * own `/^(AW|G|GT)-/` test and returns before touching the network. No tag
 * has ever loaded on either tier. A privacy policy that overstates what
 * leaves the site is still a policy that does not describe the site, and with
 * real visitors arriving it is the sentence they would act on.
 *
 * The page cannot simply drop the provider: the `PROVIDERS` guard above
 * requires every declared provider's name and host to be named here, and the
 * provider is deliberately kept declared-and-unfed so the pages and the
 * registry cannot drift (see `apps/web/src/lib/config.ts`). So what is locked
 * is the *tense*: the page may name Google Ads, and must say the tag does not
 * load, for as long as the id is empty.
 */
describe("privacy policy vs. the advertising tag that does not load (#175)", () => {
  /** The meta every page emits, and the value that is the loader's own kill
   * switch. If a real `AW-`/`G-`/`GT-` id is ever put here, this block should
   * fail loudly rather than let the page keep saying no tag loads. */
  const EMPTY_ADS_META = '<meta name="ks-google-ads-id" content="" />';

  it.each(STATIC_PAGES)("%s still emits the ads id empty", (page) => {
    expect(fs.readFileSync(path.join(SITE_PUBLIC, page), "utf8")).toContain(EMPTY_ADS_META);
  });

  it("emits it empty from the app shell too", () => {
    // `+html.tsx` is the other half: the static pages and the Expo app have
    // to agree, or a visitor's answer means different things on /privacy and
    // on /give.
    expect(fs.readFileSync(path.join(WEB_ROOT, "app/+html.tsx"), "utf8")).toContain(EMPTY_ADS_META);
  });

  it("has no reader of the removed EXPO_PUBLIC_GOOGLE_ADS_* variables left anywhere", () => {
    // The three variables and `adsEvents.ts` went together. A reader
    // reappearing without the paragraph below being rewritten is exactly the
    // sequence the policy is not allowed to lose to.
    //
    // What is searched for is the two shapes that would actually feed a tag —
    // `process.env.EXPO_PUBLIC_GOOGLE_ADS_*` in the bundle, and a
    // `%EXPO_PUBLIC_GOOGLE_ADS_*%` placeholder for `copy-site.mjs` to
    // substitute — not the bare name, which several comments explaining the
    // removal quite correctly still mention.
    const offenders: string[] = [];
    for (const root of [path.join(WEB_ROOT, "src"), path.join(WEB_ROOT, "app"), SITE_PUBLIC]) {
      for (const file of filesUnder(root)) {
        if (!/\.(ts|tsx|js|html)$/.test(file)) continue;
        const source = fs.readFileSync(file, "utf8");
        if (/process\.env\.EXPO_PUBLIC_GOOGLE_ADS/.test(source) || /%EXPO_PUBLIC_GOOGLE_ADS[A-Z_]*%/.test(source)) {
          offenders.push(path.relative(WEB_ROOT, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("says plainly that no advertising tag loads, rather than describing one that would", () => {
    expect(PRIVACY_TEXT).toContain("Keepsake runs no adverts and loads no advertising tag at all");
    expect(PRIVACY_TEXT).toContain("is empty in every version of this site that has ever been published");
    // The promise that this section is rewritten *before* a tag ships, not
    // after — the same commitment the "Search by meaning" paragraph made and
    // then kept.
    expect(PRIVACY_TEXT).toContain("this section changes first, before a single tag loads");
  });

  it("no longer tells a reader that Google receives something on consent", () => {
    // The two sentences that were true of the plumbing and never true of the
    // product.
    expect(PRIVACY_TEXT).not.toContain("Google is the recipient");
    expect(PRIVACY_TEXT).not.toContain("Google for the advertising tag, only after you consent");
  });
});

/**
 * What the published pages actually contain.
 *
 * `apps/site/public/*.html` are the only hand-written pages that ship, and
 * their HTML comments are legal reasoning written for the next editor — which
 * half of Texas's fair-notice doctrine each sentence of the indemnity is
 * doing, that the entity question underneath it was decided without a lawyer,
 * why no postal address is published and which reader that decision is about.
 * Nothing in `pnpm export` minifies HTML, so until `copy-site.mjs` learned to
 * strip them, every byte of that reasoning was in the served page.
 *
 * Two things have to hold, and neither is visible from reading either file on
 * its own: the strip step still exists, and its pattern still matches the
 * comments these pages actually contain. So the regex is pulled out of the
 * script and run against the real pages here, rather than asserting that some
 * line of code is present.
 */
describe("what ships in the static pages", () => {
  const COPY_SITE = fs.readFileSync(path.join(WEB_ROOT, "scripts/copy-site.mjs"), "utf8");

  /** `copy-site.mjs`'s own pattern, so this cannot pass against a regex the
   * build no longer uses. */
  function stripPattern(): RegExp {
    const source = /const HTML_COMMENT_RE = \/(.+?)\/g;/.exec(COPY_SITE)?.[1];
    if (!source) throw new Error("could not find HTML_COMMENT_RE in scripts/copy-site.mjs");
    return new RegExp(source, "g");
  }

  it("finds the strip step (positive control)", () => {
    // Without this the assertions below would pass on a build that stripped
    // nothing, by testing a regex nobody runs.
    expect(COPY_SITE).toContain("HTML_COMMENT_RE");
    expect(COPY_SITE).toMatch(/original\.replace\(HTML_COMMENT_RE, ""\)/);
    expect(stripPattern().test("<!-- x -->")).toBe(true);
  });

  it.each(STATIC_PAGES)("%s has every comment removed by that pattern", (page) => {
    const source = fs.readFileSync(path.join(SITE_PUBLIC, page), "utf8");
    // The source is supposed to have them — a page with none would make the
    // next assertion vacuous.
    expect(source).toContain("<!--");
    expect(source.replace(stripPattern(), "")).not.toContain("<!--");
  });

  it("does not publish the reasoning behind the legal copy", () => {
    // Named sentences rather than "no comments", because these are the ones
    // that would be quoted back: the indemnity's own drafting notes, and the
    // reason the operator's address is withheld.
    const shipped = STATIC_PAGES.map((page) =>
      fs.readFileSync(path.join(SITE_PUBLIC, page), "utf8").replace(stripPattern(), ""),
    ).join("\n");
    for (const phrase of [
      "individual-vs-LLC",
      "fair-notice doctrine",
      "express-negligence",
      "what the decision changes",
      "not a lawyer's opinion",
      "docs/legal-considerations.md",
      "docs/legal-entity-and-insurance.md",
    ]) {
      expect(shipped).not.toContain(phrase);
    }
  });

  it("keeps that reasoning in the source, where it is for", () => {
    // The other direction, and the reason this is a build step rather than a
    // deletion: stripping the comments out of the repo would lose the record
    // AGENTS.md exists to protect.
    const terms = fs.readFileSync(path.join(SITE_PUBLIC, "terms.html"), "utf8");
    expect(terms).toContain("fair-notice doctrine");
    expect(terms).toContain("docs/legal-entity-and-insurance.md");
  });
});

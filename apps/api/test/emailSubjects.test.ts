/**
 * Issue #86 — turn "sanitizeSubject runs at every `subject:` site" from a
 * comment in `src/email/templates/shared.ts` into something that fails when
 * it stops being true.
 *
 * It had already stopped being true: `requestReceived.ts` interpolated the
 * listing title straight into its subject. Nothing caught it because #20's
 * coverage was three hand-written per-template assertions (`email.test.ts`),
 * and a template nobody wrote an assertion for is a template nobody checks.
 *
 * So both checks below are *enumerating*: they discover the template modules
 * from the directory itself (`import.meta.glob`, resolved by Vite at build
 * time), which means a seventh template added next month is covered the
 * moment it lands, without anyone remembering to come back here.
 *
 * Two layers, because they fail for different reasons:
 *
 *  1. **Source-level** (`every subject: site is wrapped`) — catches the bug
 *     that actually shipped: a call site that never calls the sanitizer.
 *     A behavioural check alone would have missed it for years, because
 *     `TitleSchema` keeps hostile titles out of that path for any listing
 *     created after the schema landed, so the unwrapped subject renders
 *     clean in every test you would naturally write.
 *  2. **Behavioural** (`drive every template with a hostile value`) —
 *     catches the opposite failure: every call site wrapped, but
 *     `sanitizeSubject` itself weakened (a regex that misses `\x7f`, a
 *     dropped `.trim()`). A source scan cannot see that at all.
 *
 * The enforced rule has no exemptions: *every* `subject:` in the templates
 * directory must be `sanitizeSubject(...)`, including `recover`'s and
 * `verifyEmail`'s static string literals where it is a no-op. An exemption
 * for "subjects that don't interpolate anything" would be one more judgement
 * call for the next person to get wrong, and this repo's own history (three
 * real contrast bugs sitting inside named a11y exclusions) is the argument
 * against carving them.
 */
import { describe, expect, it } from "vitest";
import { sanitizeSubject } from "../src/email/templates/shared.js";
import type { EmailTemplate } from "../src/email/templates/shared.js";

// The pattern has to be an inline literal — `vite:import-glob` refuses a
// variable ("Could only use literals"), since it resolves the directory
// listing at build time rather than at runtime. That build-time resolution
// is exactly what makes these checks work inside the Workers runtime, which
// has no `node:fs` to read the directory itself.

/** Raw text of every file in the templates directory, keyed by glob path. */
const sources = import.meta.glob<string>("../src/email/templates/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});
/** The same files, evaluated, so their exports can actually be called. */
const modules = import.meta.glob<Record<string, unknown>>("../src/email/templates/*.ts", { eager: true });

/**
 * A "template module" is one that declares a function returning
 * `EmailTemplate` — `): EmailTemplate {`. That is a structural test, not a
 * filename list: `shared.ts` (which *declares* the interface but returns no
 * template) is excluded by the same rule that would include a new
 * `giverReminder.ts` automatically.
 */
const TEMPLATE_RETURN = /\)\s*:\s*EmailTemplate\s*\{/;

function isTemplateModule(source: string): boolean {
  return TEMPLATE_RETURN.test(source);
}

const templateFiles = Object.keys(sources)
  .filter((path) => isTemplateModule(sources[path] as string))
  .sort();

/**
 * A `subject:` *construction* site. `shared.ts`'s `subject: string;` and
 * `sendMail.ts`'s identical interface field are type annotations, not
 * constructions — they are excluded by shape (`string;` / `string,` /
 * `string\n`), not by naming a file, so a template that ever wrote
 * `subject: string` as a value would still be caught.
 */
const SUBJECT_SITE = /(?:^|[\s{,;])subject\??\s*:\s*(?!string\s*[;,\n])([\s\S]{0,24})/g;

function subjectSites(source: string): string[] {
  const sites: string[] = [];
  for (const match of source.matchAll(SUBJECT_SITE)) {
    sites.push(match[1] as string);
  }
  return sites;
}

describe("issue #86: every email subject is constructed through sanitizeSubject", () => {
  it("discovers the template modules from the directory, not from a hand-written list", () => {
    // Guards the two globs and `isTemplateModule` against silently matching
    // nothing — a source scan over zero files passes every assertion below
    // while proving exactly nothing. Six templates exist today; this floor
    // only ever needs raising, never lowering.
    expect(templateFiles.length).toBeGreaterThanOrEqual(6);
    expect(Object.keys(modules).sort()).toEqual(Object.keys(sources).sort());
    expect(templateFiles).toEqual(
      expect.arrayContaining([
        "../src/email/templates/adminTest.ts",
        "../src/email/templates/chosen.ts",
        "../src/email/templates/newRequest.ts",
        "../src/email/templates/recover.ts",
        "../src/email/templates/requestReceived.ts",
        "../src/email/templates/verifyEmail.ts",
      ]),
    );
    // `shared.ts` declares `EmailTemplate` but returns none — proof the
    // structural filter discriminates rather than matching everything.
    expect(templateFiles).not.toContain("../src/email/templates/shared.ts");
  });

  it.each(templateFiles)("%s wraps every subject: site in sanitizeSubject()", (path) => {
    const source = sources[path] as string;
    const sites = subjectSites(source);

    // A template module with no `subject:` site at all is a failure, not a
    // pass: it means either the file assembles its subject some other way
    // (`const subject = ...; return { subject }`) that this scan cannot see,
    // or the regex has rotted. Either way a human should look.
    expect(sites.length, `no subject: construction site found in ${path}`).toBeGreaterThanOrEqual(1);

    for (const site of sites) {
      expect(site, `unwrapped subject in ${path} — must be sanitizeSubject(...)`).toMatch(/^sanitizeSubject\(/);
    }

    expect(source, `${path} must import sanitizeSubject from ./shared.js`).toMatch(
      /import\s*\{[^}]*\bsanitizeSubject\b[^}]*\}\s*from\s*"\.\/shared\.js"/,
    );
  });
});

// ---------------------------------------------------------------------------
// Behavioural half: drive every exported template with a hostile value and
// assert the subject that comes back is header-safe.
//
// Each case is a builder rather than a fixed object so the hostile string is
// pushed into *every* string the template could put in its subject. The
// coverage assertion below ties this registry to the directory listing: a new
// exported template with no case here fails, which is the point — the next
// person cannot add a template and quietly skip the check.
// ---------------------------------------------------------------------------

/** CR, LF, CRLF, NUL and DEL — every class `sanitizeSubject`'s character
 * range covers, not just the newlines #20 was about. */
const DIRTY = "\x00Grandma's\nletters\rfrom\r\nthe war\x7f";
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

const HOSTILE_CASES: Record<string, () => EmailTemplate> = {
  adminTest: () =>
    (modules["../src/email/templates/adminTest.ts"] as { adminTest: (now: Date) => EmailTemplate }).adminTest(
      // `adminTest` takes a Date, and its subject is the ISO stamp — so the
      // hostile value has to arrive through `toISOString()`.
      { toISOString: () => DIRTY } as unknown as Date,
    ),
  chosen: () =>
    (modules["../src/email/templates/chosen.ts"] as { chosen: (p: Record<string, string>) => EmailTemplate }).chosen({
      listingTitle: DIRTY,
      giverEmail: DIRTY,
      handoffNote: DIRTY,
      itemLink: DIRTY,
    }),
  newRequest: () =>
    (modules["../src/email/templates/newRequest.ts"] as { newRequest: (p: Record<string, string>) => EmailTemplate }).newRequest({
      listingTitle: DIRTY,
      note: DIRTY,
      dashboardLink: DIRTY,
    }),
  recover: () =>
    (
      modules["../src/email/templates/recover.ts"] as {
        recover: (p: { link: string; ttlMs: number }) => EmailTemplate;
      }
    ).recover({
      link: DIRTY,
      ttlMs: 30 * 60 * 1000,
    }),
  requestReceived: () =>
    (
      modules["../src/email/templates/requestReceived.ts"] as {
        requestReceived: (p: Record<string, string>) => EmailTemplate;
      }
    ).requestReceived({
      listingTitle: DIRTY,
      withdrawLink: DIRTY,
    }),
  verifyEmail: () =>
    (modules["../src/email/templates/verifyEmail.ts"] as { verifyEmail: (p: Record<string, string>) => EmailTemplate }).verifyEmail({
      link: DIRTY,
    }),
};

/** Every function exported by a template module, discovered rather than listed. */
const exportedTemplateFns = templateFiles
  .flatMap((path) =>
    Object.entries(modules[path] as Record<string, unknown>)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name),
  )
  .sort();

describe("issue #86: every exported template survives a hostile value", () => {
  it("has a hostile-input case for every exported template function", () => {
    expect(exportedTemplateFns.length).toBeGreaterThanOrEqual(6);
    // Exact equality, not a subset: an uncovered new template fails here,
    // and a case for a template that no longer exists fails here too.
    expect(exportedTemplateFns).toEqual(Object.keys(HOSTILE_CASES).sort());
  });

  it.each(Object.keys(HOSTILE_CASES))("%s() returns a header-safe subject", (name) => {
    const subject = (HOSTILE_CASES[name] as () => EmailTemplate)().subject;

    expect(subject, `${name} produced an empty subject`).not.toBe("");
    expect(subject, `${name} leaked a control character into its subject`).not.toMatch(CONTROL_CHARS);
    expect(subject, `${name} did not trim its subject`).toBe(subject.trim());
  });

  it("keeps the subject readable rather than just stripping it", () => {
    // The cheap way to pass "no control characters" is to delete everything.
    // These are the templates that actually interpolate a caller-supplied
    // title, so they are the ones where the human-readable half matters.
    for (const name of ["chosen", "newRequest", "requestReceived"]) {
      const subject = (HOSTILE_CASES[name] as () => EmailTemplate)().subject;
      expect(subject, name).toContain("Grandma's");
      expect(subject, name).toContain("letters");
      expect(subject, name).toContain("the war");
    }
  });

  it("sanitizeSubject collapses each control-character class it claims to", () => {
    expect(sanitizeSubject("a\nb")).toBe("a b");
    expect(sanitizeSubject("a\rb")).toBe("a b");
    expect(sanitizeSubject("a\r\nb")).toBe("a b");
    expect(sanitizeSubject("a\x00b")).toBe("a b");
    expect(sanitizeSubject("a\x7fb")).toBe("a b");
    expect(sanitizeSubject("\n  trim me\r")).toBe("trim me");
  });
});

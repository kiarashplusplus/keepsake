/**
 * Guard: `terms.html` keeps naming the legal person its disclaimers protect.
 *
 * Keepsake is a sole proprietorship — decided in #108 on 2026-09-07, written
 * up in `docs/legal-entity-and-insurance.md`. The consequence for this page is
 * small to read and substantive to lose: "Keepsake" is not a legal person, so
 * a disclaimer, a limit, or an indemnity running to "Keepsake" runs to a name
 * with nobody behind it unless the page says who that name means. The "Who
 * you're agreeing with" section is what says it.
 *
 * That is exactly the kind of sentence a later copy edit tidies away for
 * reading flow, which is why it is pinned here rather than trusted to survive.
 * The same applies to the two halves of Texas's fair-notice doctrine the
 * indemnity clause was drafted against (#63, #34 Q8): the boxed treatment that
 * carries conspicuousness, and the sentence naming Keepsake's own negligence
 * that carries express negligence. Neither is decorative — a clause that loses
 * either one is unenforceable, and it would still look fine on the page.
 */
import fs from "node:fs";
import path from "node:path";

const TERMS_HTML = fs.readFileSync(
  path.resolve(__dirname, "../../../site/public/terms.html"),
  "utf8",
);
/** Prose here is hard-wrapped, so collapsing whitespace is what lets the
 * assertions read the page the way a person does. */
const TERMS_TEXT = TERMS_HTML.replace(/\s+/g, " ");
/** The page as a visitor receives it. `copy-site.mjs` strips HTML comments
 * from the published copy, so an assertion about what the reader is told —
 * and especially one about what the page must NOT say — has to be made
 * against this and not against `TERMS_TEXT`, which still contains the
 * drafting notes. The first draft of the blocks at the end of this file
 * asserted against `TERMS_TEXT` and failed on its own comments, which is the
 * cheerful version of the bug: the dangerous version is a positive assertion
 * that a comment quietly satisfies. */
const TERMS_SHIPPED = TERMS_HTML.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ");

describe("terms.html vs. the entity decision (#108)", () => {
  it("finds the page (positive control)", () => {
    expect(TERMS_TEXT).toContain("Governing law");
  });

  it("names the individual behind the name, and maps we/us onto him", () => {
    expect(TERMS_TEXT).toContain("Who you're agreeing with");
    expect(TERMS_TEXT).toContain("Kiarash Adl, an individual in Texas doing business as Keepsake");
    // The mapping is the operative half: without it the page names a person
    // and still leaves every clause pointing at a brand.
    expect(TERMS_TEXT).toMatch(/says "Keepsake," "we," or "us" .{0,120}it means him, personally/);
  });

  it("puts that definition before the clauses it governs", () => {
    // A definition that appears after the disclaimer it defines is worth less
    // than one that appears before it, and "before" is a property of the file,
    // not of the sentence.
    expect(TERMS_HTML.indexOf("Who you're agreeing with")).toBeLessThan(
      TERMS_HTML.indexOf('<div class="indemnity">'),
    );
  });
});

describe("terms.html vs. Texas fair notice (#63)", () => {
  it("keeps the indemnity conspicuous — the boxed, bold treatment", () => {
    expect(TERMS_HTML).toContain(".indemnity {");
    expect(TERMS_HTML).toMatch(/<div class="indemnity">\s*<p>\s*<strong>/);
  });

  it("keeps the express-negligence sentence, which a generic clause would not reach", () => {
    expect(TERMS_TEXT).toContain("a claim that Keepsake was itself negligent");
  });
});

/**
 * The content terms (2026-09-08). Three things landed together and each is a
 * claim about what the product is allowed to do, not a piece of copy.
 *
 * The licence grant is the one with a code dependency in both directions.
 * Every verb in it — store, display, thumbnail, share card, sitemap, search
 * index — names a real path (`apps/api/src/og/card.ts`, `routes/sitemap.ts`,
 * `search/embedding.ts`), and the grant is scoped to exactly those. So a new
 * use of a giver's photo that the page does not mention is not a feature with
 * a missing disclosure, it is a use nobody authorised. This block pins the
 * narrow shape — the words that make it narrow are the load-bearing ones, and
 * they are the first thing a later copy edit would smooth away.
 *
 * The copyright section is pinned for the opposite reason: for what it must
 * NOT say. Claiming the DMCA safe harbour, or naming a "designated agent",
 * before an agent is registered with the Copyright Office would be a false
 * statement in a published policy — the exact failure #87/#88/#112 were each
 * written about. Registration needs a public street address, which is an
 * errand in progress (docs/legal-next-actions-research.md §1), so the words
 * stay out until it is done. When it is, this block is where to say so.
 */
describe("terms.html vs. the content terms (2026-09-08)", () => {
  it("keeps the copyright with the person who posted it", () => {
    expect(TERMS_SHIPPED).toContain("You keep the copyright in the photos you take");
    expect(TERMS_SHIPPED).toContain("Posting a keepsake doesn't transfer any of that to us");
  });

  it("grants a licence that names every use the code actually makes", () => {
    for (const use of [
      "store your photos and words",
      "show them on Keepsake",
      "a thumbnail for the feed",
      "a share card",
      "list the page in our sitemap",
      "turn your listing's public words into the numbers that make search work",
    ]) {
      expect(TERMS_SHIPPED).toContain(use);
    }
  });

  it("keeps the grant narrow, which is the whole of what makes it honest", () => {
    // Scope, the negative, and the end date. A rewrite that keeps the grant
    // and loses any of these three has granted something much larger.
    expect(TERMS_SHIPPED).toContain("it covers running Keepsake and nothing else");
    expect(TERMS_SHIPPED).toContain("not licensed or sold to anyone");
    expect(TERMS_SHIPPED).toContain("ends when you take it down");
  });

  it("asks for the representation the grant depends on", () => {
    expect(TERMS_SHIPPED).toContain("the photo is one you took, or one you have permission to post");
  });

  it("gives a copyright complaint somewhere to go, and says what happens next", () => {
    expect(TERMS_SHIPPED).toContain("If you think something here is yours");
    expect(TERMS_SHIPPED).toContain("we hide the listing while we look");
    // §512(i) wants a repeat-infringer policy adopted *and* users told about
    // it. This sentence is the telling; deleting it would leave the policy
    // existing only in a runbook.
    expect(TERMS_SHIPPED).toContain("we ban the device key that posted it");
  });

  it("does not claim a safe harbour that has not been registered", () => {
    // Until an agent is registered with the Copyright Office, these words are
    // a claim the code and the filings cannot back. See the section's own
    // comment for what to add here on the day that changes.
    for (const overclaim of ["designated agent", "safe harbor", "safe harbour", "DMCA"]) {
      expect(TERMS_SHIPPED.toLowerCase()).not.toContain(overclaim.toLowerCase());
    }
  });
});

/**
 * The liability cap (2026-09-08). Same doctrine as the indemnity above and
 * therefore the same two failure modes, plus one of its own.
 *
 * Conspicuousness and express negligence are pinned the way #63's are. The
 * third assertion is the carve-out, and it is not boilerplate: Texas will not
 * enforce a release of gross negligence or intentional misconduct, and
 * overbroad language can taint the enforceability of the ordinary-negligence
 * limitation along with it. So the sentence naming what the cap does *not*
 * reach is what keeps the part it does reach worth having — deleting it to
 * make the clause "stronger" would make it weaker, which is exactly the edit
 * a future reader would think was an improvement.
 */
describe("terms.html vs. the liability cap (2026-09-08)", () => {
  it("is boxed, like the indemnity, because conspicuousness is the requirement", () => {
    // Two conspicuous blocks now share one class. If a second style is ever
    // introduced for one of them, this count is what notices.
    const boxes = [...TERMS_HTML.matchAll(/<div class="indemnity">/g)];
    expect(boxes).toHaveLength(2);
    expect(TERMS_HTML).toContain(".indemnity {");
  });

  it("names the cap as a number rather than as what you paid", () => {
    // "The amount you paid us" is zero here, which reads as a clause
    // pretending to concede something.
    expect(TERMS_SHIPPED).toContain("capped at $100");
  });

  it("reaches Keepsake's own negligence expressly, which a generic clause would not", () => {
    expect(TERMS_SHIPPED).toContain("That cap applies even to a claim that Keepsake was itself negligent");
  });

  it("carves out what Texas will not let it reach", () => {
    expect(TERMS_SHIPPED).toContain("It does not apply to gross negligence or deliberate wrongdoing");
    expect(TERMS_SHIPPED).toContain("nothing here takes away a right you have that can't be signed away");
  });

  it("says where a disagreement is heard, and leaves small claims alone", () => {
    expect(TERMS_SHIPPED).toContain("the state or federal courts sitting in Harris County, Texas");
    expect(TERMS_SHIPPED).toContain("you can always bring a claim in small claims court where you live");
  });
});

/**
 * The page's own record of what moved. `privacy.html` has carried one since
 * #60 and a guard that holds the newest entry to the header date; `terms.html`
 * gained both on 2026-09-08, when it also gained a cap on what Keepsake can
 * owe someone. A limit like that appearing silently, on a page whose stated
 * mechanism for telling you was a date, is the thing this exists to prevent.
 */
describe("terms.html carries a dated record of what changed", () => {
  it("has the section, dated the same day as the header", () => {
    expect(TERMS_HTML).toContain('<section id="changes">');
    const updated = /Last updated (\d{1,2} [A-Z][a-z]+ \d{4})/.exec(TERMS_SHIPPED)?.[1];
    expect(updated).toBeDefined();
    const entries = [...TERMS_SHIPPED.matchAll(/<strong>(\d{1,2} [A-Z][a-z]+ \d{4})\.<\/strong>/g)].map((m) => m[1] ?? "");
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]).toBe(updated);
  });

  it("no longer promises that the date is the entire mechanism", () => {
    // The sentence that was true until this section existed.
    expect(TERMS_SHIPPED).not.toContain("that's the entire mechanism");
  });
});

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

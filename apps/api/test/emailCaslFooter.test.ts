/**
 * Issue #310. Counsel's question ("is a request-confirmation email a CEM
 * under CASL?") resolved to: it doesn't matter which template you're asking
 * about, because s.6(6) only exempts a transactional CEM from s.6(1)(a)'s
 * *consent* requirement — it never touches s.6(2)'s sender-identification
 * and unsubscribe requirements. So every template in this directory needs
 * both, transactional or not (`docs/design/email.md`).
 *
 * This is deliberately one test that iterates every template rather than
 * one test per template (the mistake `emailSubjects.test.ts`'s header
 * describes for #86): a template added next month with no footer coverage
 * fails this immediately, because the discovery below is structural
 * (`import.meta.glob` + "declares a function returning `EmailTemplate`"),
 * not a hand-maintained list. The `FIXTURES` registry existing is itself
 * checked against that discovery, so a new template with no fixture here
 * fails loudly instead of silently passing zero assertions.
 *
 * Two assertions per template, both required because #310's fix has two
 * halves that can fail independently:
 *
 * 1. The identification line and the unsubscribe line each appear in the
 *    rendered **HTML**.
 * 2. The identification line and the unsubscribe line each appear in the
 *    rendered **text** — several templates (`chosen`, `newRequest`,
 *    `recover`, `confirmRequest`, `requestReceived`, `verifyEmail`,
 *    `adminTest`, `dailyDigest`) build `text:` by hand rather than
 *    stripping the HTML shell, so a footer that only reached `renderShell`
 *    would leave every plain-text client — and every client that prefers
 *    text over HTML — with no identification and no unsubscribe path at
 *    all. `footerLine()` is the single place both parts are kept in sync;
 *    this test is what makes that fact provable rather than assumed.
 */
import { describe, expect, it } from "vitest";
import {
  CASL_IDENTIFICATION_LINE,
  CASL_TRANSACTIONAL_LINE,
  CASL_UNSUBSCRIBE_LINE,
  UNSUBSCRIBE_LINK_PLACEHOLDER,
  type EmailTemplate,
} from "../src/email/templates/shared.js";
import { RECOVER_TTL_MS } from "../src/routes/recover.js";

/** Same technique as `emailSubjects.test.ts`: resolved at build time by
 * Vite's `import.meta.glob`, which is what makes this work inside the
 * Workers runtime (no `node:fs` to list a directory at runtime). */
const sources = import.meta.glob<string>("../src/email/templates/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});
const modules = import.meta.glob<Record<string, unknown>>("../src/email/templates/*.ts", { eager: true });

const TEMPLATE_RETURN = /\)\s*:\s*EmailTemplate\s*\{/;

/** Every function exported by a module whose source declares a template
 * (`shared.ts` itself is excluded — it declares the interface, returns
 * none), named `path#exportName` so a module with more than one export
 * (there are none today, but nothing here assumes that stays true) is still
 * covered individually. */
const discoveredTemplateFns: string[] = Object.entries(sources)
  .filter(([, source]) => TEMPLATE_RETURN.test(source))
  .flatMap(([path]) =>
    Object.entries(modules[path] as Record<string, unknown>)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => `${path}#${name}`),
  )
  .sort();

/** Renders each real template with minimal fixture params. A function, not
 * a plain `EmailTemplate`, because `adminTest` and `dailyDigest` take
 * arguments the fixture has to supply. */
const FIXTURES: Record<string, () => EmailTemplate> = {
  "../src/email/templates/adminTest.ts#adminTest": () =>
    (modules["../src/email/templates/adminTest.ts"] as { adminTest: (now: Date) => EmailTemplate }).adminTest(
      new Date("2026-01-01T00:00:00.000Z"),
    ),
  "../src/email/templates/chosen.ts#chosen": () =>
    (modules["../src/email/templates/chosen.ts"] as { chosen: (p: Record<string, string>) => EmailTemplate }).chosen({
      listingTitle: "Grandma's teapot",
      giverEmail: "giver@fixture.test",
      handoffNote: "Would love to give this a good home.",
      itemLink: "https://fixture.test/item",
    }),
  "../src/email/templates/confirmRequest.ts#confirmRequest": () =>
    (
      modules["../src/email/templates/confirmRequest.ts"] as {
        confirmRequest: (p: Record<string, string>) => EmailTemplate;
      }
    ).confirmRequest({ listingTitle: "Grandma's teapot", confirmLink: "https://fixture.test/confirm" }),
  "../src/email/templates/dailyDigest.ts#dailyDigest": () =>
    (
      modules["../src/email/templates/dailyDigest.ts"] as {
        dailyDigest: (report: unknown) => EmailTemplate;
      }
    ).dailyDigest({
      date: "2026-09-09",
      generated_at: 0,
      environment: "preview",
      commit: "abcdef1234",
      needs_attention: [],
      listings: { created: 0, approved: 0, rejected: 0, pending_now: 0, needs_review_now: 0, oldest_pending_age_ms: null },
      requests: { created: 0, chosen: 0 },
      email: { attempted: 0, failed: 0, top_error: null },
      reports: { autohidden_awaiting_review: 0, near_threshold: 0 },
      budgets: {
        mod_text: { used: 0, limit: 1 },
        mod_image: { used: 0, limit: 1 },
        suggest: { used: 0, limit: 1 },
        embed: { used: 0, limit: 1 },
      },
      crons: [],
    }),
  "../src/email/templates/newRequest.ts#newRequest": () =>
    (
      modules["../src/email/templates/newRequest.ts"] as { newRequest: (p: Record<string, string>) => EmailTemplate }
    ).newRequest({
      listingTitle: "Grandma's teapot",
      note: "Would love to give this a good home.",
      dashboardLink: "https://fixture.test/dashboard",
    }),
  "../src/email/templates/recover.ts#recover": () =>
    (
      modules["../src/email/templates/recover.ts"] as { recover: (p: { link: string; ttlMs: number }) => EmailTemplate }
    ).recover({ link: "https://fixture.test/recover", ttlMs: RECOVER_TTL_MS }),
  "../src/email/templates/requestReceived.ts#requestReceived": () =>
    (
      modules["../src/email/templates/requestReceived.ts"] as {
        requestReceived: (p: Record<string, string>) => EmailTemplate;
      }
    ).requestReceived({ listingTitle: "Grandma's teapot", withdrawLink: "https://fixture.test/withdraw" }),
  "../src/email/templates/verifyEmail.ts#verifyEmail": () =>
    (
      modules["../src/email/templates/verifyEmail.ts"] as { verifyEmail: (p: Record<string, string>) => EmailTemplate }
    ).verifyEmail({ link: "https://fixture.test/verify" }),
};

describe("issue #310: every template's footer carries CASL identification + unsubscribe", () => {
  it("has a fixture for every discovered template function, and no fixture for one that doesn't exist", () => {
    // Both directions matter: a discovered template with no fixture here is
    // a template this test silently doesn't check (the #86 postmortem);
    // a fixture for a template that's been removed is dead code that would
    // hide the same gap on the next rename.
    expect(discoveredTemplateFns.length).toBeGreaterThanOrEqual(8);
    expect(Object.keys(FIXTURES).sort()).toEqual(discoveredTemplateFns);
  });

  it.each(Object.keys(FIXTURES))("%s HTML carries identification and unsubscribe", (key) => {
    const { html } = (FIXTURES[key] as () => EmailTemplate)();
    expect(html, `${key}: missing CASL identification line in HTML`).toContain(CASL_IDENTIFICATION_LINE);
    expect(html, `${key}: missing CASL unsubscribe line in HTML`).toContain(CASL_UNSUBSCRIBE_LINE);
    expect(html, `${key}: missing the line naming what still arrives in HTML`).toContain(CASL_TRANSACTIONAL_LINE);
  });

  it.each(Object.keys(FIXTURES))("%s text carries identification and unsubscribe", (key) => {
    const { text } = (FIXTURES[key] as () => EmailTemplate)();
    expect(text, `${key}: missing CASL identification line in text — a hand-built text: part that never reached footerLine()`).toContain(
      CASL_IDENTIFICATION_LINE,
    );
    expect(text, `${key}: missing CASL unsubscribe line in text — a hand-built text: part that never reached footerLine()`).toContain(
      CASL_UNSUBSCRIBE_LINE,
    );
    expect(
      text,
      `${key}: missing the line naming what still arrives in text — a hand-built text: part that never reached footerLine()`,
    ).toContain(CASL_TRANSACTIONAL_LINE);
  });

  it("the unsubscribe line names a real electronic address and an honoring window, not just the word 'unsubscribe'", () => {
    // CASL accepts a stated electronic address the recipient can write to
    // (it doesn't require a one-click mechanism) provided requests are
    // given effect within 10 business days. A line that merely says
    // "unsubscribe" without saying where or how fast wouldn't meet that —
    // this pins the two facts that make it a real mechanism rather than a
    // gesture at one.
    expect(CASL_UNSUBSCRIBE_LINE).toContain("hello@keepsake.ing");
    expect(CASL_UNSUBSCRIBE_LINE).toMatch(/10 business days/);

    // The footer goes out on all eight kinds, seven of which
    // `TRANSACTIONAL_EMAIL_KINDS` sends regardless of suppression. So it may
    // never claim to stop "messages like this" — that sentence is false the
    // moment it rides on a `chosen` or a `confirm_request` — and it has to
    // say what does keep arriving.
    expect(CASL_UNSUBSCRIBE_LINE, "the footer must not promise to stop the message carrying it").not.toMatch(
      /messages like this/i,
    );
    expect(CASL_TRANSACTIONAL_LINE).toMatch(/still arrive/i);
  });

  it.each(Object.keys(FIXTURES))(
    "%s carries the one-click unsubscribe hook in both HTML and text (issue #310 part two)",
    (key) => {
      // The literal placeholder, not a real URL — these template functions
      // are pure and render before `sendMail` (`../src/email/sendMail.ts`)
      // substitutes a per-recipient link. This proves every template keeps
      // the hook, which is what makes the substitution automatic for a
      // template added later rather than one more thing to remember.
      const { html, text } = (FIXTURES[key] as () => EmailTemplate)();
      expect(html, `${key}: missing the unsubscribe link hook in HTML`).toContain(UNSUBSCRIBE_LINK_PLACEHOLDER);
      expect(text, `${key}: missing the unsubscribe link hook in text`).toContain(UNSUBSCRIBE_LINK_PLACEHOLDER);
    },
  );

  it("the identification line names the actual legal person, not just the product name", () => {
    // s.6(2)(a): identification of the person who sent the message. Keepsake
    // is a DBA, not an entity — apps/site/public/terms.html is explicit that
    // it "isn't a company" — so "Keepsake" alone would identify a trade name
    // with nobody behind it.
    expect(CASL_IDENTIFICATION_LINE).toContain("Kiarash Adl");
  });
});

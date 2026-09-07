/**
 * Issue #33: every email Keepsake sends is transactional, and that is
 * load-bearing — `docs/legal-considerations.md` recommendation 9 records
 * that CAN-SPAM, CASL and UK PECR all exempt purely transactional mail from
 * their consent/unsubscribe rules, "regardless of the ads rollout," but that
 * exemption survives only "as long as it stays purely transactional." One
 * added line ("check out what else is available") reclassifies the whole
 * message as marketing under all three regimes. Nothing before this test
 * stopped that from happening quietly in a future edit.
 *
 * This renders every real template (`../src/email/templates/*`) with fixture
 * params and checks the actual `subject`/`html`/`text` output two ways:
 *
 * 1. **Structural link check.** Every URL/mailto the template renders must be
 *    one of the fixture links this test supplied as a parameter (or, for
 *    `chosen`, the fixture reply-to address). A hardcoded marketing link
 *    baked into template source — e.g. `<a href="https://keepsake.ing/browse">`
 *    — cannot match a fixture sentinel and gets caught regardless of the
 *    anchor text wrapped around it.
 * 2. **Phrase check.** A curated set of patterns for marketing CTAs, urgency/
 *    discount language, referral incentives, cross-promotion, and
 *    unsubscribe-implying copy (a transactional email that starts talking
 *    about "email preferences" is itself a symptom of drifting into
 *    marketing).
 *
 * Honesty about the phrase check: it is pattern matching, not comprehension.
 * A determined rephrase that avoids every listed pattern and doesn't add a
 * hardcoded link (e.g. folding a soft pitch into an existing sentence with
 * no CTA verb and no link) can still walk past it. The link check is the
 * stronger of the two guards because a promotional push almost always wants
 * a destination, but neither check is a substitute for review of new copy.
 */
import { describe, expect, it } from "vitest";
import { chosen } from "../src/email/templates/chosen.js";
import { newRequest } from "../src/email/templates/newRequest.js";
import { recover } from "../src/email/templates/recover.js";
import { RECOVER_TTL_MS } from "../src/routes/recover.js";
import { requestReceived } from "../src/email/templates/requestReceived.js";
import { verifyEmail } from "../src/email/templates/verifyEmail.js";
import { adminTest } from "../src/email/templates/adminTest.js";
import type { EmailTemplate } from "../src/email/templates/shared.js";

// Distinctive per-field sentinels so a leaked hardcoded link can never be
// mistaken for one of these by coincidence.
const ITEM_LINK = "https://fixture.test/sentinel/item-link";
const DASHBOARD_LINK = "https://fixture.test/sentinel/dashboard-link";
const RECOVER_LINK = "https://fixture.test/sentinel/recover-link";
const WITHDRAW_LINK = "https://fixture.test/sentinel/withdraw-link";
const VERIFY_LINK = "https://fixture.test/sentinel/verify-link";
const GIVER_EMAIL = "sentinel-giver@fixture.test";

interface Case {
  name: string;
  template: EmailTemplate;
  /** Every href/mailto/bare-URL the rendered output is allowed to contain. */
  allowedUrls: string[];
}

const CASES: Case[] = [
  {
    name: "chosen (with giver email)",
    template: chosen({
      listingTitle: "Grandma's teapot",
      giverEmail: GIVER_EMAIL,
      handoffNote: "Would love to give this a good home.",
      itemLink: ITEM_LINK,
    }),
    allowedUrls: [ITEM_LINK, `mailto:${GIVER_EMAIL}`],
  },
  {
    name: "chosen (no giver email — reply-to only)",
    template: chosen({
      listingTitle: "Grandma's teapot",
      handoffNote: "Would love to give this a good home.",
      itemLink: ITEM_LINK,
    }),
    allowedUrls: [ITEM_LINK],
  },
  {
    name: "newRequest",
    template: newRequest({
      listingTitle: "Grandma's teapot",
      note: "Would love to give this a good home.",
      dashboardLink: DASHBOARD_LINK,
    }),
    allowedUrls: [DASHBOARD_LINK],
  },
  {
    name: "recover",
    template: recover({ link: RECOVER_LINK, ttlMs: RECOVER_TTL_MS }),
    allowedUrls: [RECOVER_LINK],
  },
  {
    name: "requestReceived",
    template: requestReceived({
      listingTitle: "Grandma's teapot",
      withdrawLink: WITHDRAW_LINK,
    }),
    allowedUrls: [WITHDRAW_LINK],
  },
  {
    name: "verifyEmail",
    template: verifyEmail({ link: VERIFY_LINK }),
    allowedUrls: [VERIFY_LINK],
  },
  {
    name: "adminTest",
    template: adminTest(new Date("2026-01-01T00:00:00.000Z")),
    allowedUrls: [],
  },
];

/** `href="..."` attributes in the HTML body. */
function extractHrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
}

/** Bare `http(s)://` or `mailto:` URLs anywhere in plain text (the `.text`
 * body links are never wrapped in markup). Only meant to run over `.text` —
 * running it over raw HTML would swallow the closing `"` or `</p>` that
 * follows a `href="..."` attribute, since those have no whitespace before
 * the next markup character. */
function extractBareUrls(text: string): string[] {
  return [...text.matchAll(/(https?:\/\/[^\s"<>]+|mailto:[^\s"<>]+)/g)].map((m) => m[1]!);
}

/**
 * Promotional-language markers, grouped by what makes each one promotional
 * rather than transactional:
 *
 * - a call to action pointed at browsing/shopping generally, not the one
 *   transaction this email is about;
 * - urgency or discount framing, which only exists to drive a purchase or
 *   engagement decision;
 * - referral/growth incentives ("invite a friend");
 * - cross-promotion of other listings ("you might also like");
 * - language that implies this is a marketing subscription someone could
 *   unsubscribe from — a transactional email should never need to say this,
 *   and reaching for it is itself a sign the copy drifted into marketing.
 */
const PROMOTIONAL_PATTERNS: { label: string; pattern: RegExp }[] = [
  {
    label: "generic browse/shop call-to-action",
    pattern: /\b(check out|browse|shop|explore|discover)\b(?:\s+\w+){0,5}?\s+(more|other|new|available|listings|keepsakes)\b/i,
  },
  {
    label: "urgency/scarcity marketing",
    pattern: /\b(limited time|don't miss|while (it|they) last|act now|hurry|last chance)\b/i,
  },
  {
    label: "discount/sale language",
    pattern: /(\d+%\s*off|\bsale\b|\bdiscount\b|\bpromo\s*code\b|\bcoupon\b|\bspecial offer\b)/i,
  },
  {
    label: "referral/growth incentive",
    pattern: /\b(refer a friend|invite (a )?friends?|earn (rewards|points|credit)|share (keepsake|this) with)\b/i,
  },
  {
    label: "cross-promotion of unrelated listings",
    pattern: /\b(you (might|may) (also )?like|similar (keepsakes|listings|items)|recommended for you|based on your (interest|activity)|more like this)\b/i,
  },
  {
    label: "newsletter/marketing-consent language",
    pattern: /\b(newsletter|marketing (email|communications?)|promotional (email|content|offers?))\b/i,
  },
  {
    label: "unsubscribe-implying language",
    pattern: /\b(unsubscribe|opt[- ]?out of( future| marketing| promotional)?\s*emails?|manage (your )?(email )?(preferences|subscription))\b/i,
  },
];

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ");
}

describe("transactional email templates never gain promotional content (#33)", () => {
  for (const { name, template, allowedUrls } of CASES) {
    describe(name, () => {
      it("contains no links other than the fixture's own transactional links", () => {
        // `extractHrefs` catches anything wrapped in an `<a href>`;
        // `extractBareUrls` (run over the tag-stripped HTML and the plain
        // text body) catches a URL dropped in as visible copy with no link
        // markup at all, e.g. `plainLinkLine`'s "Or paste this link...".
        const found = new Set([...extractHrefs(template.html), ...extractBareUrls(stripTags(template.html)), ...extractBareUrls(template.text)]);
        const unexpected = [...found].filter((url) => !allowedUrls.includes(url));
        expect(unexpected, `unexpected link(s) in "${name}": ${JSON.stringify(unexpected)} — allowed were ${JSON.stringify(allowedUrls)}`).toEqual([]);
      });

      it("contains no promotional-language markers", () => {
        const haystack = `${template.subject}\n${stripTags(template.html)}\n${template.text}`;
        const hits = PROMOTIONAL_PATTERNS.map(({ label, pattern }) => {
          const match = haystack.match(pattern);
          return match ? `${label} (matched "${match[0]}")` : null;
        }).filter((x): x is string => x !== null);
        expect(hits, `promotional language found in "${name}": ${hits.join("; ")}`).toEqual([]);
      });
    });
  }
});

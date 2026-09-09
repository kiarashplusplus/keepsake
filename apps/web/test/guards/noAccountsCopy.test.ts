/**
 * Guard: no page a visitor reads claims Keepsake has "no accounts".
 *
 * It was true enough to print until 2026-09-08, when the give flow's email
 * step lost its "Skip" and `POST /api/listings` started refusing a first
 * listing from an owner with no address (`docs/design/identity.md`, "Always
 * asked for"). Nothing about the *architecture* changed — there is still no
 * username, no password and no profile, and `docs/product-decisions.md` still
 * records the decision as "no accounts" because what it rules out is an auth
 * system. What changed is what the phrase promises a reader: someone who is
 * told "no accounts" and is then required to hand over an email before their
 * listing will post has been told something that isn't so, on the marketing
 * page, the explainer, and two published policies at once.
 *
 * So the copy says "no password" — which is the part that stayed true — and
 * this guard is what stops the shorter, nicer, wrong phrase coming back the
 * next time someone reaches for a hook. It is deliberately a *negative*
 * assertion over the shipped text plus a positive control on the code that
 * makes the claim false: if the email requirement is ever lifted, the control
 * fails first and tells you this whole file is the thing to reconsider,
 * rather than leaving a stale prohibition nobody can explain.
 */
import fs from "node:fs";
import path from "node:path";

const WEB_ROOT = path.resolve(__dirname, "../..");
const SITE_PUBLIC = path.resolve(WEB_ROOT, "../site/public");
const API_SRC = path.resolve(WEB_ROOT, "../api/src");

const LISTINGS_ROUTE = path.join(API_SRC, "routes/listings.ts");
const GIVE_EMAIL_SCREEN = path.join(WEB_ROOT, "app/give/email.tsx");

/** Everything a visitor reads, by the route they read it on. `llms.txt` is
 * served at `keepsake.ing/llms.txt` and is a description of the product in
 * the same voice, so it belongs here and not in a "docs" exemption. */
const READER_FACING: { name: string; file: string; until?: string }[] = [
  { name: "about.html", file: path.join(SITE_PUBLIC, "about.html") },
  // `until`: both policies keep a hand-written "what changed" log, and an
  // entry recording that a phrase was removed has to quote the phrase. That
  // is the one place on either page where "no accounts" is not a claim about
  // the product but a note about what the page used to say, so the assertion
  // stops at the log rather than the log being written around the assertion.
  {
    name: "privacy.html",
    file: path.join(SITE_PUBLIC, "privacy.html"),
    until: '<section id="changes">',
  },
  {
    name: "terms.html",
    file: path.join(SITE_PUBLIC, "terms.html"),
    until: '<section id="changes">',
  },
  { name: "app/welcome.tsx", file: path.join(WEB_ROOT, "app/welcome.tsx") },
  // The explainer's body copy — what `/welcome` and a first visit to `/`
  // both show. `app/welcome.tsx` above keeps only the route's description.
  { name: "src/features/welcome/Explainer.tsx", file: path.join(WEB_ROOT, "src/features/welcome/Explainer.tsx") },
  { name: "public/llms.txt", file: path.join(WEB_ROOT, "public/llms.txt") },
];

/**
 * The phrase, in the shapes it actually took on these pages before this
 * change: "no accounts", "no account to log into", "doesn't have accounts",
 * "without an account". Anchored with a word boundary so "accountable" — the
 * word privacy.html uses for the controller, five times — is not a match.
 */
const NO_ACCOUNT_CLAIM =
  /\bno accounts?\b|\b(?:does|do)(?:n't| not) have accounts\b|\bwithout an account\b/i;

/** Source as the reader receives it: HTML comments are stripped by
 * `copy-site.mjs` at build time and `//` comments never ship at all, so an
 * assertion about what a page *says* has to be made with both gone. The
 * drafting notes in these files discuss the old phrasing on purpose, and a
 * guard that failed on its own explanation would be useless. */
function shipped(file: string, until?: string): string {
  const source = fs.readFileSync(file, "utf8");
  const end = until === undefined ? source.length : source.indexOf(until);
  if (end < 0) throw new Error(`could not find ${until} in ${file}`);
  return source
    .slice(0, end)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s+/g, " ");
}

describe("the reader-facing pages vs. the email requirement", () => {
  it("finds the requirement in the code (positive control)", () => {
    // The route check is the invariant — a client that stops asking cannot
    // reopen the hole — so it, not the form, is what makes "no accounts"
    // false. Both halves are asserted: the form is where a person meets it.
    const route = fs.readFileSync(LISTINGS_ROUTE, "utf8").replace(/^\s*\/\/.*$/gm, "");
    expect(route).toContain("input.email === undefined && owner.email === null");
    expect(route).toContain("An email is needed so we can tell you when someone asks for this.");

    const giveEmail = fs.readFileSync(GIVE_EMAIL_SCREEN, "utf8").replace(/^\s*\/\/.*$/gm, "");
    expect(giveEmail).not.toContain("Skip");
  });

  it("finds the pages (positive control)", () => {
    // A renamed file, or an `until` marker that no longer exists, would
    // otherwise make every assertion below pass against an empty string —
    // `shipped` throws on the second, and this covers the first.
    for (const { name, file, until } of READER_FACING) {
      expect([name, shipped(file, until).length > 200]).toEqual([name, true]);
    }
  });

  it.each(READER_FACING)("$name doesn't tell a reader there are no accounts", ({ file, until }) => {
    const match = NO_ACCOUNT_CLAIM.exec(shipped(file, until));
    // The message carries the sentence, because the fix is always a rewrite
    // of that sentence and never a tweak to the pattern above.
    expect(
      match === null ||
        `claims "no accounts": ...${match.input.slice(Math.max(0, match.index - 90), match.index + 90)}...`,
    ).toBe(true);
  });

  it("still says the true half out loud", () => {
    // The replacement claim has to survive too: dropping "no accounts" and
    // saying nothing in its place would pass every assertion above while
    // losing the thing the phrase was there to promise.
    expect(shipped(path.join(WEB_ROOT, "src/features/welcome/Explainer.tsx"))).toContain("No passwords. No money.");
    expect(shipped(path.join(SITE_PUBLIC, "privacy.html"))).toContain(
      "No password, just a device key",
    );
    expect(shipped(path.join(SITE_PUBLIC, "terms.html"))).toContain(
      "Your device key — there is no password",
    );
  });
});

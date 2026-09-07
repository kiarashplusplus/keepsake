/**
 * Guard: the Terms are put in front of someone at the moment they agree to
 * them.
 *
 * WHY
 *
 * `apps/site/public/terms.html` carries a one-way indemnification clause —
 * the giver covers Keepsake for claims arising from the handoff, expressly
 * including a claim that Keepsake was itself negligent. It is boxed and
 * bolded on purpose: Texas's fair-notice doctrine has a conspicuousness
 * half, and issue #63's decision comment records the drafting against it.
 *
 * The other half is that the clause was actually presented. Before
 * `src/ui/LegalAssent.tsx`, nothing in the give flow, the request sheet or
 * the age gate referenced `/terms` at all — a grep for "terms" across all
 * three returned nothing — and the only route to the page was the persistent
 * `AppFooter`. That is the weaker half of the doctrine carrying the whole
 * load, and it is the kind of gap that disappears silently in a refactor of
 * a screen nobody was thinking about legally.
 *
 * So: the two submit surfaces must reference the assent line, and the assent
 * line must link to both published pages. Deleting either usage fails here.
 */
import fs from "node:fs";
import path from "node:path";

const WEB_ROOT = path.resolve(__dirname, "..", "..");
const ASSENT = path.join(WEB_ROOT, "src/ui/LegalAssent.tsx");

/** The screens where a person commits — a listing, and a request. */
const SUBMIT_SURFACES = ["app/give/review.tsx", "src/features/request/RequestSheet.tsx"];

function read(relative: string): string {
  return fs.readFileSync(path.join(WEB_ROOT, relative), "utf8");
}

describe("the Terms are presented where they are agreed to", () => {
  it("the shared assent component exists (positive control)", () => {
    // Without this every assertion below could pass by asserting about a
    // file that no longer exists — the vacuous shape AGENTS.md's table is
    // made of.
    expect(fs.existsSync(ASSENT)).toBe(true);
  });

  it.each(SUBMIT_SURFACES)("%s shows the assent line", (file) => {
    const source = read(file);
    expect(source).toContain("LegalAssent");
    // Imported *and* rendered — an unused import would satisfy a naive
    // substring check while showing the user nothing.
    expect(source).toMatch(/<LegalAssent\s+action=/);
  });

  it("links to both published pages", () => {
    const source = fs.readFileSync(ASSENT, "utf8");
    expect(source).toContain('href="/terms"');
    expect(source).toContain('href="/privacy"');
  });

  it("names the indemnity to the giver rather than pointing at the Terms generally", () => {
    // The specific obligation is the one a reasonable person would want
    // flagged; "you agree to the Terms" on its own does not flag it. If the
    // clause in terms.html is ever rewritten, this sentence has to be
    // revisited with it — which is the point of pinning it.
    expect(fs.readFileSync(ASSENT, "utf8")).toContain("cover Keepsake for what happens");
  });

  it("does not claim a requester carries the giver's indemnity", () => {
    // The clause is one-directional (issue #63 rejected "mutual"). A
    // requester's line saying otherwise would be a false statement about
    // what they just agreed to.
    const source = fs.readFileSync(ASSENT, "utf8");
    const requesterHalf = source.slice(source.indexOf('action === "give"'));
    const requesterLine = requesterHalf.slice(requesterHalf.indexOf("By sending this"));
    expect(requesterLine).not.toContain("cover Keepsake");
  });
});

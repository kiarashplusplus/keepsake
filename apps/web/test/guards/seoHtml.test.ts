/**
 * Guard: `scripts/seo-html.mjs` writes the right robots answer onto the right
 * pages, and — the one that matters most — never writes one onto the shell
 * every listing page is built from.
 *
 * `dist/item/[id].html` is the file `apps/api/src/routes/item.ts` reads and
 * rewrites into every `/item/:id` response. That rewriter removes the shell's
 * `title`, `description`, `og:*`, `twitter:*` and canonical before appending
 * the listing's own — it does **not** remove `<meta name="robots">`. So a
 * noindex that reached that one file would be inherited by every listing page
 * on the site: the entire content surface, deindexed, from what looks in a
 * diff like a route being added to a list. There is nothing at runtime that
 * would fail, and nothing in the export log that would say so.
 *
 * The script defaults an unrecognised route to `noindex`, which is the right
 * direction for an app with five indexable pages and twenty flow steps behind
 * a token — but it makes exactly that mistake cheap to make. Hence this file.
 *
 * Runs against the source, not `dist/`: jest does not build the app, and a
 * guard that silently skips when `dist/` is absent is worse than no guard
 * (the same argument `bundleBoundaries.test.ts` makes). The parts of the
 * script that need real files — `404.html` being written, the canonical
 * landing in the head — are asserted by `apps/api/test/notFound.test.ts`
 * against the served bytes and by `e2e/staticRender.spec.ts` against a real
 * export.
 */
import fs from "node:fs";
import path from "node:path";

const SCRIPT_PATH = path.resolve(__dirname, "../../scripts/seo-html.mjs");
const SCRIPT = fs.readFileSync(SCRIPT_PATH, "utf8");

/** The script with its comments removed. It explains at length why certain
 * routes are and are not in each list, and that prose matches a naive
 * `toContain` for the route names — an assertion about the lists has to look
 * at code, not at the paragraphs describing it. */
const CODE = SCRIPT.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * The string literals of a `new Set([...])` / `[...]` assigned to `name`.
 *
 * Terminated on `];`/`]);` rather than the first `]`, because the values
 * themselves contain one — `item/[id].html` is Expo Router's own filename for
 * a dynamic route, and a `[^\]]*` body match silently returns an EMPTY list
 * for the one entry this file exists to assert on.
 */
function literalList(name: string): string[] {
  const match = new RegExp(`const ${name} = (?:new Set\\()?\\[([\\s\\S]*?)\\]\\)?;`).exec(CODE);
  if (match === null) throw new Error(`seo-html.mjs no longer declares ${name}`);
  const values = [...(match[1] ?? "").matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "");
  // Empty is always a failure: either the list really was emptied (which is
  // the mistake these tests exist for) or the reader above stopped matching
  // it (which would make every assertion below vacuously pass).
  if (values.length === 0) throw new Error(`seo-html.mjs's ${name} read as empty — emptied, or no longer parsed`);
  return values;
}

describe("scripts/seo-html.mjs", () => {
  it("never touches the shell every listing page is rewritten from", () => {
    expect(literalList("NEVER_TOUCH")).toContain("item/[id].html");
  });

  it("indexes exactly the Expo routes that are meant to be found", () => {
    // `/about`, `/privacy` and `/terms` are `apps/site`'s and carry their own
    // canonical; `/item/:id` gets one from the Worker. Everything else the
    // app exports is a flow step or is behind a token.
    expect(literalList("INDEXABLE").sort()).toEqual(["/", "/give", "/welcome"]);
  });

  it("keeps the give flow's interior steps out of the indexable set", () => {
    const indexable = literalList("INDEXABLE");
    for (const step of ["/give/story", "/give/details", "/give/review", "/give/email"]) {
      expect(indexable).not.toContain(step);
    }
  });

  it("agrees with the sitemap about which Expo routes are indexable", () => {
    // Two lists, two languages, one answer. A page in `INDEXABLE` that the
    // sitemap omits is an orphan (which is what `/welcome` and `/give` both
    // were until 2026-09-09); a page in the sitemap that this script
    // noindexes is the sitemap telling a crawler to fetch something the page
    // then tells it to drop.
    const sitemap = fs.readFileSync(path.resolve(__dirname, "../../../api/src/routes/sitemap.ts"), "utf8");
    const paths = /const STATIC_PATHS = \[([^\]]*)\]/.exec(sitemap);
    expect(paths).not.toBeNull();
    const listed = [...(paths?.[1] ?? "").matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "");
    for (const route of literalList("INDEXABLE")) {
      expect(listed).toContain(route);
    }
  });

  it("removes expo-router's built-in route index from the export", () => {
    // `/_sitemap` was live at 200 on production and renders a list of every
    // route in the app, `/admin` and `/bulk` included. It is a development
    // affordance; `noindex` would still leave it fetchable and linkable.
    expect(literalList("DEV_ONLY")).toContain("_sitemap.html");
  });

  it("builds canonicals from the production origin, absolute", () => {
    // A relative canonical is legal and a relative `og:url` is not — Facebook
    // and WhatsApp mishandle it, the same defect `rootOpenGraph.test.ts`
    // guards `og:image` against.
    const origin = /const ORIGIN = "([^"]*)"/.exec(CODE)?.[1];
    expect(origin).toBe("https://keepsake.ing");
  });

  it("lets a crawler keep following links out of a noindexed page", () => {
    // `noindex, follow`, not `noindex, nofollow`: these pages carry the
    // shared header and footer, and there is no reason to dead-end a crawl
    // at them.
    expect(CODE).toContain('content="noindex, follow"');
    expect(CODE).not.toContain("noindex, nofollow");
  });
});

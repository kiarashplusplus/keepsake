/**
 * Guard: the bare `keepsake.ing` link unfurls with a picture.
 *
 * `/` is the single most-shared URL this product has, and until 2026-09-07 its
 * `og:image` was **relative** (`/og-default.png`). Facebook and WhatsApp both
 * want an absolute URL and mishandle a relative one, so the domain unfurled as
 * a bare text preview in the two places that matter most — while looking
 * completely fine in every local check, because the exported HTML was valid
 * and the asset was really there.
 *
 * That is the shape of failure this whole area has: nothing errors, nothing
 * logs, and the only witness is a crawler that never complains. Hence a guard
 * on the source of the shell rather than trust that nobody will "tidy" an
 * absolute URL back into a relative one.
 *
 * The per-listing equivalent (`/item/:id`) is asserted server-side in
 * `apps/api/test/item.test.ts`, against the actual rewritten response.
 */
import fs from "node:fs";
import path from "node:path";
import { feedQueryFromUrlParams } from "@/features/feed/feedUrlParams";

const SHELL = fs.readFileSync(path.resolve(__dirname, "../../app/+html.tsx"), "utf8");

/**
 * `SHELL` with comments removed. The file explains at length why certain tags
 * are absent, and prose about `<link rel="canonical">` matches a naive
 * `not.toContain` for the tag itself — an absence assertion has to look at
 * code, not at the paragraph describing the absence.
 */
const SHELL_CODE = SHELL.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const SITE_PAGES = ["about.html", "privacy.html", "terms.html"].map((f) =>
  fs.readFileSync(path.resolve(__dirname, "../../../site/public", f), "utf8"),
);

/** `<meta property="og:image" content="..." />` → the content value. */
function metaContent(source: string, attr: "property" | "name", key: string): string | null {
  const pattern = new RegExp(`${attr}="${key}"\\s+content="([^"]*)"`);
  const alt = new RegExp(`content="([^"]*)"\\s+${attr}="${key}"`);
  return pattern.exec(source)?.[1] ?? alt.exec(source)?.[1] ?? null;
}

describe("the root shell's Open Graph tags", () => {
  it("gives og:image an absolute URL", () => {
    const image = metaContent(SHELL, "property", "og:image");
    expect(image).not.toBeNull();
    expect(image).toMatch(/^https:\/\/keepsake\.ing\//);
  });

  it("declares og:type and og:site_name", () => {
    expect(metaContent(SHELL, "property", "og:type")).toBe("website");
    expect(metaContent(SHELL, "property", "og:site_name")).toBe("Keepsake");
  });

  it("declares NO canonical and NO og:url, because this shell is every page", () => {
    // These are per-page values and `+html.tsx` is one shell shared by all
    // ~17 exported routes. A canonical of `https://keepsake.ing/` in here
    // tells a crawler that /welcome, /give, /mine and the rest are duplicates
    // of the homepage — which is how this was caught: they were added, and
    // `dist/` showed the tag on every page.
    //
    // `/item/:id` gets a real canonical and og:url from the Worker's
    // rewriter (asserted in `apps/api/test/item.test.ts`), and `apps/site`'s
    // static pages carry their own.
    //
    // The rest of the routes get theirs from `scripts/seo-html.mjs` at
    // export time (2026-09-09), which is the one place a per-route value can
    // be written truthfully: the exported *files* are per-route even though
    // this component is not. That does not weaken this assertion, it is the
    // reason for it — the tag has a correct home now, and this is not it.
    // `test/guards/seoHtml.test.ts` covers that side.
    expect(SHELL_CODE).not.toContain('rel="canonical"');
    expect(metaContent(SHELL_CODE, "property", "og:url")).toBeNull();
  });

  it("declares the image's real dimensions and type", () => {
    // `apps/site/public/og-default.png` is 1200x630. Advertising dimensions
    // lets a client lay out the preview before the image finishes loading;
    // advertising the WRONG ones makes it lay out the wrong box.
    const png = fs.readFileSync(path.resolve(__dirname, "../../../site/public/og-default.png"));
    expect(png.readUInt32BE(16)).toBe(Number(metaContent(SHELL, "property", "og:image:width")));
    expect(png.readUInt32BE(20)).toBe(Number(metaContent(SHELL, "property", "og:image:height")));
    expect(metaContent(SHELL, "property", "og:image:type")).toBe("image/png");
  });

  it("has alt text for the card", () => {
    const alt = metaContent(SHELL, "property", "og:image:alt");
    expect(alt).toBeTruthy();
    expect((alt as string).length).toBeGreaterThan(20);
  });

  it("uses the same absolute origin as the static marketing pages", () => {
    // One convention, not two. `apps/site/public/*.html` have always
    // hardcoded `https://keepsake.ing`; the shell now matches, which is what
    // makes "don't read it from `config.siteUrl`" a rule rather than an
    // oversight (that value is `""` in production by design).
    for (const page of SITE_PAGES) {
      expect(metaContent(page, "property", "og:image")).toMatch(/^https:\/\/keepsake\.ing\//);
    }
  });
});

describe("the root shell's structured data", () => {
  /** The `ROOT_JSON_LD` literal, parsed. */
  function rootJsonLd(): Record<string, unknown>[] {
    const match = /const ROOT_JSON_LD = JSON\.stringify\((\[[\s\S]*?\n\])\);/.exec(SHELL);
    expect(match).not.toBeNull();
    // The literal is JS, not JSON (unquoted keys), so it is evaluated rather
    // than parsed. Reading the source instead of the built output is the
    // point: a guard on `dist/` only holds after an export has run.
    return new Function(`return ${(match as RegExpExecArray)[1] as string}`)() as Record<string, unknown>[];
  }

  it("declares a WebSite and an Organization, linked by @id", () => {
    const nodes = rootJsonLd();
    const website = nodes.find((n) => n["@type"] === "WebSite") as Record<string, unknown>;
    const org = nodes.find((n) => n["@type"] === "Organization") as Record<string, unknown>;
    expect(website).toBeTruthy();
    expect(org).toBeTruthy();
    // The link is what tells a consumer these are one subject rather than two
    // things that share a name.
    expect((website.publisher as Record<string, unknown>)["@id"]).toBe(org["@id"]);
  });

  it("describes a SearchAction the feed can actually answer", () => {
    // The whole risk with a `SearchAction` is describing an entry point that
    // does not work. This resolves the declared template against the feed's
    // own parser rather than eyeballing the query key.
    const website = rootJsonLd().find((n) => n["@type"] === "WebSite") as Record<string, unknown>;
    const action = website.potentialAction as Record<string, unknown>;
    const template = (action.target as Record<string, unknown>).urlTemplate as string;

    expect(action["query-input"]).toBe("required name=search_term_string");
    expect(template).toContain("{search_term_string}");

    const url = new URL(template.replace("{search_term_string}", "teacup"));
    expect(url.pathname).toBe("/");
    const params: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      params[key] = value;
    });
    expect(feedQueryFromUrlParams(params).q).toBe("teacup");
  });

  it("does not claim a logo Google would reject", () => {
    // `favicon.png` is 64x64 and the Organization logo guidance wants >=112.
    // A rejected `logo` turns a clean parse into a validation warning, so
    // there is deliberately none. If one is added, this test should be
    // replaced by an assertion on the new file's real dimensions.
    const org = rootJsonLd().find((n) => n["@type"] === "Organization") as Record<string, unknown>;
    if (org.logo !== undefined) {
      const logoUrl = (org.logo as Record<string, unknown>).url as string;
      const file = path.resolve(__dirname, "../../public", logoUrl.replace(/^https:\/\/keepsake\.ing\//, ""));
      const png = fs.readFileSync(file);
      expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(112);
      expect(png.readUInt32BE(20)).toBeGreaterThanOrEqual(112);
    }
  });

  it("keeps the root redirect from eating a search query, and only a search query", () => {
    // `SearchAction` sends a client to `/?q=...`, and that client is by
    // definition a first-time visitor — exactly the one the pre-hydration
    // script redirects to `/welcome`, dropping `location.search` on the way.
    // The structured data above is only true because of this condition.
    expect(SHELL).toContain('new URLSearchParams(window.location.search).has("q")');
    expect(SHELL).toContain('window.location.pathname === "/" && !searching && !returning');

    // And specifically `q` — NOT "any query string", which is what this
    // originally said. `?fbclid=`, `?gclid=` and `?utm_source=` are how a
    // first-time visitor arrives from an ad or a shared link; skipping the
    // explainer for them would also set VISITED_KEY on the way past, so they
    // would never see it at all. Keepsake runs Google Ads.
    expect(SHELL_CODE).not.toContain("&& !window.location.search &&");
  });

  it("carries the query string across to /welcome instead of dropping it", () => {
    // The redirect fires for exactly one visitor — a first-timer at `/` with
    // no `q` — and that is precisely the visitor who arrived from an ad or a
    // shared link carrying `utm_*`, `gclid` or `fbclid`. A bare
    // `location.replace("/welcome")` drops `location.search`, so every one of
    // those died on the one hop nobody could see, and the campaign that paid
    // for the click was unattributable.
    expect(SHELL_CODE).toContain('window.location.replace("/welcome" + window.location.search)');
    expect(SHELL_CODE).not.toContain('window.location.replace("/welcome")');
  });
});

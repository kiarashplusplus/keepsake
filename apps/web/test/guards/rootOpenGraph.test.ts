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

const SHELL = fs.readFileSync(path.resolve(__dirname, "../../app/+html.tsx"), "utf8");
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

  it("declares og:url, og:type and og:site_name", () => {
    // `og:url` was missing entirely. Without it an unfurler falls back to
    // whatever URL it happened to be given, including one carrying tracking
    // parameters, and treats two spellings of the same page as two pages.
    expect(metaContent(SHELL, "property", "og:url")).toBe("https://keepsake.ing/");
    expect(metaContent(SHELL, "property", "og:type")).toBe("website");
    expect(metaContent(SHELL, "property", "og:site_name")).toBe("Keepsake");
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

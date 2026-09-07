/**
 * Unit tests for `src/og/text.ts` — the share card's line breaking.
 *
 * This is the only part of the card with real logic in it, and it is the part
 * that cannot be checked by looking at one rendered sample: a wrap decision is
 * wrong only for the inputs nobody happened to render. The card SVG itself is
 * verified by looking at the artifact (`tools/og/render-samples.mjs`), which
 * is the right tool for a layout and the wrong one for an off-by-one.
 *
 * No Worker, no bindings — these are pure functions, so this file deliberately
 * does not use `SELF.fetch` like the rest of `test/`.
 *
 * The advance table these exercise was measured off the real font, and the
 * measurement is asserted end-to-end nowhere in CI: reproducing it needs
 * resvg, which is a Worker-bundle concern. What IS asserted here is that the
 * model stays internally consistent — monospace exactness, monotonicity, and
 * that every line a wrap produces actually fits the column it was given.
 */
import { describe, expect, it } from "vitest";
import { cardStoryExcerpt, escapeXml, isRenderable, measureText, WRAP_SAFETY, wrapText } from "../src/og/text.js";

describe("measureText", () => {
  it("is exact for Courier Prime, which is monospace", () => {
    // 600/1000 units per glyph, every glyph. If this ever stops holding, the
    // eyebrow / place / footer / stamp lines stop being exact and the whole
    // "layer 1" claim in the module header is false.
    expect(measureText("Somerville, MA", "courier", 18)).toBeCloseTo(14 * 0.6 * 18, 5);
    expect(measureText("iiii", "courier", 20)).toBeCloseTo(measureText("MMMM", "courier", 20), 5);
  });

  it("applies letter-spacing between glyphs, not after the last one", () => {
    // Matches SVG's own `letter-spacing`. Getting this wrong by one gap is
    // how the stamp's box ends up a few pixels too wide for its label.
    const tracked = measureText("FREE", "courier", 28, 6);
    const plain = measureText("FREE", "courier", 28, 0);
    expect(tracked - plain).toBeCloseTo(3 * 6, 5);
  });

  it("scales linearly with font size", () => {
    expect(measureText("Grandmother's teacup", "fraunces", 88)).toBeCloseTo(
      measureText("Grandmother's teacup", "fraunces", 44) * 2,
      5,
    );
  });

  it("gives Fraunces proportional widths", () => {
    expect(measureText("MMMM", "fraunces", 44)).toBeGreaterThan(measureText("iiii", "fraunces", 44));
  });

  it("is zero for the empty string", () => {
    // The `letterSpacing * (length - 1)` term would otherwise go negative.
    expect(measureText("", "courier", 18, 6)).toBe(0);
  });
});

describe("wrapText", () => {
  const OPTS = { font: "fraunces", fontSize: 44, maxWidth: 480, maxLines: 3 } as const;

  it("never returns a line wider than the column", () => {
    // The property that actually matters: `card.ts`'s clip path sits at
    // `maxWidth`, and it is a backstop that should never fire.
    //
    // Asserted against the RAW column, not against `maxWidth * WRAP_SAFETY`.
    // The first version of this test used the safety-adjusted figure, which
    // made it self-referential — setting `WRAP_SAFETY` to 1.4 left it green,
    // because the assertion moved with the bug.
    const inputs = [
      "Grandmother's teacup",
      "Hand-planed oak bookshelf from a workshop in Vermont",
      "A completely absurd and unreasonably long keepsake title of exactly eighty ch",
      "WAVE MAXIMUM WIDTH IN CAPITALS",
      "Émile's café chair, ñandú leather",
    ];
    for (const input of inputs) {
      for (const line of wrapText(input, OPTS)) {
        expect(measureText(line, "fraunces", 44)).toBeLessThanOrEqual(OPTS.maxWidth);
      }
    }
  });

  it("leaves headroom below the column for kerning the advance table cannot see", () => {
    // `measureText` sums per-character advances; it has no view of kerning
    // pairs or shaping. `WRAP_SAFETY` is the margin that covers the
    // difference, so it has to actually be a margin.
    expect(WRAP_SAFETY).toBeGreaterThan(0.9);
    expect(WRAP_SAFETY).toBeLessThan(1);
  });

  it("keeps short text on one line", () => {
    expect(wrapText("Brass sextant", OPTS)).toEqual(["Brass sextant"]);
  });

  it("returns no lines for empty or whitespace-only input", () => {
    expect(wrapText("", OPTS)).toEqual([]);
    expect(wrapText("   \n  ", OPTS)).toEqual([]);
  });

  it("caps at maxLines and ellipsises the last one at a word boundary", () => {
    const lines = wrapText(
      "A completely absurd and unreasonably long keepsake title of exactly eighty ch",
      OPTS,
    );
    expect(lines).toHaveLength(3);
    expect(lines[2]?.endsWith("…")).toBe(true);
    // Never mid-word, and never a dangling separator before the ellipsis.
    expect(lines[2]).not.toMatch(/[\s,;:.—-]…$/);
  });

  it("does not ellipsise when the text fits exactly at maxLines", () => {
    const lines = wrapText("Hand-planed oak bookshelf from a workshop", { ...OPTS, maxLines: 3 });
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines.join("")).not.toContain("…");
  });

  it("breaks a single word that can never fit, rather than letting it overhang", () => {
    // A serial number, a URL, a German compound. The clip path would eat this
    // silently; a hyphenated break is visibly deliberate.
    const lines = wrapText("Donaudampfschiffahrtsgesellschaftskapitaen", { ...OPTS, maxWidth: 200 });
    for (const line of lines) {
      expect(measureText(line, "fraunces", 44)).toBeLessThanOrEqual(200 * WRAP_SAFETY);
    }
    expect(lines.length).toBeGreaterThan(1);
  });

  it("collapses runs of whitespace", () => {
    expect(wrapText("Brass    sextant", OPTS)).toEqual(["Brass sextant"]);
  });
});

describe("cardStoryExcerpt", () => {
  it("delegates to the shared rule: a short first sentence comes back whole", () => {
    // Same rule the feed card uses (`@keepsake/contracts/story`), so a
    // keepsake reads the same in the feed and in a link preview.
    expect(cardStoryExcerpt("Thirty years of stirring. The bowl is worn flat.")).toBe("Thirty years of stirring.");
  });

  it("collapses the giver's line breaks before excerpting", () => {
    // This is the whole reason the wrapper exists. `storyExcerpt` treats a
    // newline as a sentence terminator, so a hard-wrapped story would
    // otherwise excerpt to its first typed line rather than its first
    // sentence. The card sets its own line breaks, so the source must arrive
    // as one run of text.
    const hardWrapped = "My grandmother kept this\non the windowsill above her sink. Then it sat in a box.";
    expect(cardStoryExcerpt(hardWrapped)).toBe(
      "My grandmother kept this on the windowsill above her sink.",
    );
  });

  it("truncates at a word boundary with an ellipsis when nothing fits", () => {
    const long = "This mug has been in my family since before I was born and it has no punctuation at all here";
    const excerpt = cardStoryExcerpt(long, 40);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt.endsWith(" …")).toBe(false);
    expect(excerpt.length).toBeLessThanOrEqual(41);
  });

  it("returns a short unpunctuated story untouched", () => {
    expect(cardStoryExcerpt("A small brass compass")).toBe("A small brass compass");
  });
});

describe("isRenderable", () => {
  it("accepts the Latin the card's two fonts actually cover", () => {
    expect(isRenderable("Grandmother's teacup")).toBe(true);
    expect(isRenderable("Émile's café — ñandú, 1998…")).toBe(true);
  });

  it("rejects scripts neither font covers", () => {
    // resvg draws NOTHING for an uncovered glyph — not tofu — so an
    // unrenderable title has to be detected here or it becomes a silent hole
    // in the card that looks like a rendering bug.
    expect(isRenderable("おばあちゃんの湯呑み")).toBe(false);
    expect(isRenderable("Бабушкина чашка")).toBe(false);
    expect(isRenderable("فنجان جدتي")).toBe(false);
  });

  it("rejects a title that is only partly unrenderable", () => {
    expect(isRenderable("Teacup 湯呑み")).toBe(false);
  });
});

describe("escapeXml", () => {
  it("escapes the five XML predefined entities", () => {
    expect(escapeXml(`a & b < c > d " e ' f`)).toBe("a &amp; b &lt; c &gt; d &quot; e &apos; f");
  });

  it("escapes an ampersand before the entities it introduces", () => {
    // The classic double-escape bug: `&lt;` must not become `&amp;lt;`.
    expect(escapeXml("<b>")).toBe("&lt;b&gt;");
    expect(escapeXml("&amp;")).toBe("&amp;amp;");
  });

  it("neutralises markup a title could otherwise inject into the SVG", () => {
    const escaped = escapeXml(`</text><script>alert(1)</script>`);
    expect(escaped).not.toContain("<");
    expect(escaped).not.toContain(">");
  });
});

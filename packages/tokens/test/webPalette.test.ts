import { describe, expect, it } from "vitest";
import { colorsDark, colorsLight, colorsWeb, TABLE_TOKENS, themeCssVariables, type ColorTokens } from "../src/colors";

const ALL_KEYS = Object.keys(colorsLight) as (keyof ColorTokens)[];

/**
 * The web palette and the stylesheet that feeds it are two halves of one
 * mechanism, written in different files and different languages: `colorsWeb`
 * emits `var(--ks-bg, …)` into every component's style, and
 * `themeCssVariables()` is what gives `--ks-bg` a value. If they ever stop
 * agreeing on a name, nothing throws — the `var()` silently falls back to
 * its light default, dark mode quietly stops working for that token, and the
 * only witness is someone looking at the site at night.
 */
describe("the web palette", () => {
  it("makes a variable of every token that flips, and of nothing else", () => {
    for (const key of ALL_KEYS) {
      const flips = colorsLight[key] !== colorsDark[key];
      expect(flips, `${key}`).toBe((TABLE_TOKENS as readonly string[]).includes(key));
      expect(colorsWeb[key].startsWith("var(--ks-"), `${key}`).toBe(flips);
    }
  });

  it("falls back to the light value inside each var()", () => {
    // A page that loses the inline stylesheet renders the light table, not a
    // transparent one.
    for (const token of TABLE_TOKENS) {
      expect(colorsWeb[token]).toBe(`var(--ks-${kebab(token)}, ${colorsLight[token]})`);
    }
  });

  it("declares every variable it references, in both themes, with the palette's own values", () => {
    const css = themeCssVariables();
    const root = block(css, ":root");
    const dark = block(css, '[data-theme="dark"]');

    for (const token of TABLE_TOKENS) {
      const name = `--ks-${kebab(token)}`;
      // The reference in the markup and the declaration in the stylesheet
      // are asserted against each other, not against a hand-written list.
      expect(colorsWeb[token]).toContain(`var(${name},`);
      expect(root).toContain(`${name}: ${colorsLight[token]};`);
      expect(dark).toContain(`${name}: ${colorsDark[token]};`);
    }
    // Nothing else is declared: a stray variable here is a token someone
    // removed from TABLE_TOKENS without removing its CSS.
    expect(root.match(/--ks-/g)).toHaveLength(TABLE_TOKENS.length);
    expect(dark.match(/--ks-/g)).toHaveLength(TABLE_TOKENS.length);
  });
});

const kebab = (token: string): string => token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** The body of one selector's block in the generated stylesheet. */
function block(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

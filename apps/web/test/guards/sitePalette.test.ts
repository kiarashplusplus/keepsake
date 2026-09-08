/**
 * Guard: `apps/site/public/site.css`'s palette stays tied to
 * `packages/tokens/src/colors.ts`, and its two dark-mode copies —
 * `html[data-theme="dark"]` (an explicit choice) and the
 * `@media (prefers-color-scheme: dark)` fallback (no stored preference) —
 * never drift apart from each other.
 *
 * Written for issue #273: `#256` rewrote this file's `:root` block from
 * `packages/tokens` and left both dark blocks on the pre-refresh palette, so
 * the static site was quietly running two colour systems by theme, and the
 * dark blocks inverted ten tokens the app keeps constant. Nothing tied
 * `site.css` to `packages/tokens` before this test, though the file's own
 * header claims it is "built from" them.
 *
 * What this deliberately does NOT do: pin the ink-family dark values
 * (`--ink`/`--text2`/`--text3`/`--surface`/`--accent2*`/`--rule`/
 * `--foil-text`) to `packages/tokens`. Those are a genuine, documented
 * departure from the app — see `site.css`'s header comment and
 * `docs/design/design-system.md`'s "v3" section — because this site puts
 * prose directly on the table ground and the app never does. This test
 * instead asserts those tokens actually DO flip (so the departure can't
 * silently revert to the app's constant model and go illegible) and that
 * both dark copies of them agree with each other (so the two blocks can't
 * quietly diverge from EACH OTHER the way this issue's "table" tokens did
 * from `packages/tokens`).
 */
import fs from "node:fs";
import path from "node:path";
import { colorsDark, colorsLight, type ColorTokens } from "@keepsake/tokens/colors";
import { contrastRatio } from "@keepsake/tokens/contrast";

const CSS = fs.readFileSync(path.resolve(__dirname, "../../../site/public/site.css"), "utf8");

/** The `{ ... }` body of the first rule whose selector matches `selectorRe`, tracking brace depth so it also works for the `@media` block that nests one more rule inside it. */
function ruleBody(css: string, selectorRe: RegExp): string {
  const m = selectorRe.exec(css);
  if (!m) throw new Error(`selector not found in site.css: ${selectorRe}`);
  let i = css.indexOf("{", m.index);
  if (i < 0) throw new Error(`no opening brace after ${selectorRe}`);
  const start = i;
  let depth = 0;
  for (; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start + 1, i);
    }
  }
  throw new Error(`unbalanced braces after ${selectorRe}`);
}

/** `--foo-bar: value;` pairs in a rule body, as declared (not resolved) — none of the custom properties this test reads contain a `;` inside their own value. */
function customProps(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/gi)) {
    out[m[1] as string] = (m[2] as string).trim();
  }
  return out;
}

const norm = (v: string): string => v.toLowerCase().replace(/\s+/g, "");

const root = customProps(ruleBody(CSS, /:root\s*\{/));
const darkAttr = customProps(ruleBody(CSS, /html\[data-theme="dark"\]\s*\{/));
const mediaDarkBody = ruleBody(CSS, /@media \(prefers-color-scheme: dark\)\s*\{/);
const darkMedia = customProps(ruleBody(mediaDarkBody, /html:not\(\[data-theme="light"\]\):not\(\[data-theme="dark"\]\)\s*\{/));

/** site.css var -> the packages/tokens key it must equal exactly (the "table" — the only tokens allowed to differ between light and dark, per `TABLE_TOKENS`). */
const TABLE_VAR_TO_TOKEN: Record<string, keyof ColorTokens> = {
  "--bg": "bg",
  "--surface-sunken": "surfaceSunken",
  "--shadow": "shadow",
  "--shadow-strong": "shadowStrong",
  "--lamp": "lampLight",
};

/** The stamp-red / print-white family: constant in `packages/tokens` AND, per `docs/design/design-system.md`, the one family this site also keeps constant. Must never be redefined as a custom property in either dark block. */
const NEVER_DARK_OVERRIDE = ["--accent", "--accent-text", "--on-accent", "--accent-soft", "--print", "--foil", "--on-foil"];

/** The ink-family tokens this site deliberately flips (unlike the app) so prose sitting bare on the table stays legible when the table goes dark. Pinned here only to prove they still DO flip, and that both dark copies agree — see the file header above for why their values aren't checked against `packages/tokens`. */
const DELIBERATELY_FLIPPED = ["--ink", "--ink-soft", "--text2", "--text3", "--surface", "--accent2", "--accent2-text", "--on-accent2", "--rule", "--foil-text"];

describe("apps/site/public/site.css palette (issue #273)", () => {
  it("both dark-mode copies ([data-theme] and prefers-color-scheme) declare the identical set of custom properties", () => {
    expect(darkMedia).toEqual(darkAttr);
  });

  it("the table tokens match packages/tokens/src/colors.ts exactly, in both light and dark", () => {
    for (const [cssVar, tokenKey] of Object.entries(TABLE_VAR_TO_TOKEN)) {
      // Failure names the css var/token pair via the object under test,
      // since jest's `expect` (unlike vitest's) takes no message argument.
      expect({ cssVar, mode: "light", value: norm(root[cssVar] as string) }).toEqual({
        cssVar,
        mode: "light",
        value: norm(colorsLight[tokenKey]),
      });
      expect({ cssVar, mode: "dark", value: norm(darkAttr[cssVar] as string) }).toEqual({
        cssVar,
        mode: "dark",
        value: norm(colorsDark[tokenKey]),
      });
    }
  });

  it("the stamp-red / print-white family is never redefined in either dark block", () => {
    for (const cssVar of NEVER_DARK_OVERRIDE) {
      expect({ cssVar, inDarkAttr: cssVar in darkAttr, inDarkMedia: cssVar in darkMedia }).toEqual({
        cssVar,
        inDarkAttr: false,
        inDarkMedia: false,
      });
    }
  });

  it("the ink-family tokens that deliberately flip actually do flip, identically in both dark copies", () => {
    for (const cssVar of DELIBERATELY_FLIPPED) {
      expect(darkAttr[cssVar]).toBeDefined();
      expect({ cssVar, dark: norm(darkAttr[cssVar] as string) }).not.toEqual({ cssVar, dark: norm(root[cssVar] as string) });
      expect({ cssVar, media: norm(darkMedia[cssVar] as string) }).toEqual({ cssVar, media: norm(darkAttr[cssVar] as string) });
    }
  });

  it("--accent-text (light) clears 3:1 on the light table — the constant value .step-icon relies on", () => {
    expect(norm(root["--accent-text"] as string)).toBe(norm(colorsLight.accentText));
    const ratio = contrastRatio(root["--accent-text"] as string, root["--bg"] as string);
    expect(ratio).toBeGreaterThanOrEqual(3);
  });

  it(".step-icon's dark-mode override clears 3:1 (non-text graphic) against the dark table, identically in both dark paths", () => {
    const matches = [...CSS.matchAll(/\.step-icon\s*\{\s*color:\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => (m[1] as string).toLowerCase());
    // One in html[data-theme="dark"], one in the prefers-color-scheme copy —
    // exactly two, since the constant light-mode rule uses var(--accent-text)
    // rather than a literal hex and so isn't matched here.
    expect(matches).toHaveLength(2);
    expect(matches[0]).toBe(matches[1]);

    const stepIconColor = matches[0] as string;
    const ratioOnBg = contrastRatio(stepIconColor, darkAttr["--bg"] as string);
    const ratioOnSurface = contrastRatio(stepIconColor, darkAttr["--surface"] as string);
    expect(ratioOnBg).toBeGreaterThanOrEqual(3);
    expect(ratioOnSurface).toBeGreaterThanOrEqual(3);
  });
});

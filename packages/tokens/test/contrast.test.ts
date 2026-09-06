import { describe, expect, it } from "vitest";
import { colorsDark, colorsLight, TABLE_TOKENS, TEXT_ON_GROUND_TOKENS, type ColorTokens } from "../src/colors";
import { contrastRatio } from "../src/contrast";
import { motion, motionSafe } from "../src/motion";

const AA = 4.5;
const ALL_KEYS = Object.keys(colorsLight) as (keyof ColorTokens)[];

describe("colour contrast (WCAG AA) — Polaroids on a table", () => {
  it("every token except the table itself is byte-identical between light and dark (objects on the table never invert)", () => {
    for (const key of ALL_KEYS) {
      if ((TABLE_TOKENS as readonly string[]).includes(key)) continue;
      expect(colorsDark[key], `${key} should be constant`).toBe(colorsLight[key]);
    }
  });

  it("the table itself is never pure black or white", () => {
    for (const c of [colorsLight, colorsDark]) {
      expect(c.bg.toLowerCase()).not.toBe("#000000");
      expect(c.bg.toLowerCase()).not.toBe("#ffffff");
    }
  });

  describe("objects on the table read on both papers", () => {
    for (const token of TEXT_ON_GROUND_TOKENS) {
      for (const ground of ["surface", "print"] as const) {
        it(`${token} on ${ground} >= ${AA}:1`, () => {
          const ratio = contrastRatio(colorsLight[token], colorsLight[ground]);
          expect(ratio, `${token} ${colorsLight[token]} on ${ground} ${colorsLight[ground]} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(AA);
        });
      }
    }
  });

  it("ink on kraft (the table, light mode) >= 4.5:1", () => {
    const ratio = contrastRatio(colorsLight.ink, colorsLight.bg);
    expect(ratio, `ink ${colorsLight.ink} on kraft ${colorsLight.bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(AA);
  });

  it("pencil on print white >= 4.5:1", () => {
    expect(contrastRatio(colorsLight.pencil, colorsLight.print)).toBeGreaterThanOrEqual(AA);
  });

  it("stampText (text-safe red) on print white >= 4.5:1", () => {
    expect(contrastRatio(colorsLight.stampText, colorsLight.print)).toBeGreaterThanOrEqual(AA);
  });

  it("print white (onAccent) on the stamp red fill >= 4.5:1", () => {
    expect(contrastRatio(colorsLight.onAccent, colorsLight.accent)).toBeGreaterThanOrEqual(AA);
  });

  it("print white (onAccent2) on the ink fill >= 4.5:1 ('print white on ink')", () => {
    expect(contrastRatio(colorsLight.onAccent2, colorsLight.accent2)).toBeGreaterThanOrEqual(AA);
  });

  it("accentText on accentSoft >= 4.5:1 (tape-tinted chips)", () => {
    expect(contrastRatio(colorsLight.accentText, colorsLight.accentSoft)).toBeGreaterThanOrEqual(AA);
  });

  it("onFoil on foil >= 4.5:1 (aged label)", () => {
    expect(contrastRatio(colorsLight.onFoil, colorsLight.foil)).toBeGreaterThanOrEqual(AA);
  });

  it("ink on the chrome surface (index cards, sheets, inputs) >= 4.5:1", () => {
    expect(contrastRatio(colorsLight.ink, colorsLight.surface)).toBeGreaterThanOrEqual(AA);
  });
});

describe("motionSafe", () => {
  it("returns the tokens untouched when motion is allowed", () => {
    const m = motionSafe(false);
    expect(m.spring).toEqual(motion.spring);
    expect(m.dropMs).toBe(motion.dropMs);
    expect(m.reduce).toBe(false);
  });
  it("zeroes every loop and duration under reduce-motion", () => {
    const m = motionSafe(true);
    expect(m.reduce).toBe(true);
    expect(m.dropMs).toBe(0);
    expect(m.shimmerMs).toBe(0);
    expect(m.standardMs).toBe(0);
    expect(m.liftMs).toBe(0);
    expect(m.tiltDeg).toBe(0);
    expect(m.reviewTiltDeg).toBe(0);
    expect(m.spring.stiffness).toBeGreaterThan(motion.spring.stiffness);
  });
});

import { describe, expect, it } from "vitest";
import { colorsDark, colorsLight, TEXT_ON_GROUND_TOKENS } from "../src/colors";
import { contrastRatio } from "../src/contrast";
import { motion, motionSafe } from "../src/motion";

const AA = 4.5;

describe("colour contrast (WCAG AA)", () => {
  for (const [mode, c] of [
    ["light", colorsLight],
    ["dark", colorsDark],
  ] as const) {
    describe(mode, () => {
      for (const token of TEXT_ON_GROUND_TOKENS) {
        for (const ground of ["bg", "surface", "surfaceSunken"] as const) {
          it(`${token} on ${ground} >= ${AA}:1`, () => {
            const ratio = contrastRatio(c[token], c[ground]);
            expect(ratio, `${token} ${c[token]} on ${ground} ${c[ground]} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(AA);
          });
        }
      }
      it("onAccent on accent >= 4.5:1", () => {
        expect(contrastRatio(c.onAccent, c.accent)).toBeGreaterThanOrEqual(AA);
      });
      it("accentText on accentSoft >= 4.5:1 (selected chips)", () => {
        expect(contrastRatio(c.accentText, c.accentSoft)).toBeGreaterThanOrEqual(AA);
      });
      it("never pure black or white grounds", () => {
        expect(c.bg.toLowerCase()).not.toBe("#000000");
        expect(c.bg.toLowerCase()).not.toBe("#ffffff");
      });
    });
  }
});

describe("motionSafe", () => {
  it("returns the tokens untouched when motion is allowed", () => {
    const m = motionSafe(false);
    expect(m.spring).toEqual(motion.spring);
    expect(m.sealBreathMs).toBe(motion.sealBreathMs);
    expect(m.reduce).toBe(false);
  });
  it("zeroes every loop and duration under reduce-motion", () => {
    const m = motionSafe(true);
    expect(m.reduce).toBe(true);
    expect(m.sealBreathMs).toBe(0);
    expect(m.shimmerMs).toBe(0);
    expect(m.standardMs).toBe(0);
    expect(m.spring.stiffness).toBeGreaterThan(motion.spring.stiffness);
  });
});

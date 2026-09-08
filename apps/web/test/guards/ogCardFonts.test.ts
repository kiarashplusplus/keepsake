/**
 * Guards on the share card's fonts. Both failures these catch are silent:
 * resvg does not report a missing family or an uncovered glyph, it just draws
 * nothing, so neither shows up as an error anywhere — only as a card with a
 * hole in it that nobody looks at until a friend gets one.
 *
 * These read the TTF binaries rather than trusting a constant, because the
 * whole point is that the string in `card.ts` and the string in the font's
 * own `name` table have to agree, and asserting a constant against itself
 * proves nothing.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

// Lives here, under Jest, rather than beside the code in `apps/api/test/`:
// that suite runs in `@cloudflare/vitest-pool-workers`, whose sandbox has no
// filesystem, and this guard's entire job is to read the bytes that ship. The
// same reason `termsOperator.test.ts` and `privacyPolicy.test.ts` reach into
// `apps/site` from here.
const FONT_DIR = path.resolve(__dirname, "../../../api/src/og/fonts");
const WEB_FONT_DIR = path.resolve(__dirname, "../../public/fonts");
const CARD_SOURCE = readFileSync(path.resolve(__dirname, "../../../api/src/og/card.ts"), "utf8");

/**
 * Reads name ID 1 (font family) out of a TrueType `name` table.
 *
 * Deliberately hand-rolled rather than pulled from a font library: this test
 * exists to check the bytes that actually ship, and a library that normalises
 * or prefers a typographic-family record (name ID 16) would report the name
 * fontdb *doesn't* match on.
 */
function familyName(bytes: Buffer): string {
  const numTables = bytes.readUInt16BE(4);
  let nameOffset = -1;
  for (let i = 0; i < numTables; i += 1) {
    const rec = 12 + i * 16;
    if (bytes.toString("ascii", rec, rec + 4) === "name") {
      nameOffset = bytes.readUInt32BE(rec + 8);
      break;
    }
  }
  if (nameOffset < 0) throw new Error("no name table");

  const count = bytes.readUInt16BE(nameOffset + 2);
  const stringOffset = nameOffset + bytes.readUInt16BE(nameOffset + 4);
  for (let i = 0; i < count; i += 1) {
    const rec = nameOffset + 6 + i * 12;
    const platformId = bytes.readUInt16BE(rec);
    const nameId = bytes.readUInt16BE(rec + 6);
    if (nameId !== 1) continue;
    const length = bytes.readUInt16BE(rec + 8);
    const offset = stringOffset + bytes.readUInt16BE(rec + 10);
    const raw = Buffer.from(bytes.subarray(offset, offset + length));
    // Platform 3 (Windows) stores UTF-16**BE**; Node only decodes UTF-16LE,
    // so the bytes have to be swapped first. Reading them as-is yields
    // plausible-looking CJK ("䘀爀愀甀渀挀攀猀" for "Fraunces"), which is how
    // this was caught.
    return platformId === 3 ? raw.swap16().toString("utf16le") : raw.toString("latin1");
  }
  throw new Error("no family name record");
}

function readFont(dir: string, name: string): Buffer {
  return readFileSync(path.join(dir, name));
}

describe("card font families", () => {
  it("uses exactly the family names in the shipped files' name tables", () => {
    // The recorded trap (docs/design/design-system.md): Courier Prime's
    // family is "Courier Prime" WITH A SPACE, not the `CourierPrime` token
    // name the rest of the codebase uses for the CSS `@font-face` family.
    // Write the token name in the SVG and resvg falls back silently — the
    // caption renders in Fraunces, or not at all.
    const families = new Set([
      familyName(readFont(FONT_DIR, "Fraunces-Display-VF.ttf")),
      familyName(readFont(FONT_DIR, "Fraunces-Display-Italic-VF.ttf")),
      familyName(readFont(FONT_DIR, "CourierPrime-Regular.ttf")),
      familyName(readFont(FONT_DIR, "CourierPrime-Bold.ttf")),
    ]);
    expect(families).toEqual(new Set(["Fraunces", "Courier Prime"]));

    const used = [...CARD_SOURCE.matchAll(/font-family="([^"$]+)"/g)].map((m) => m[1] as string);
    expect(used.length).toBeGreaterThan(0);
    for (const family of used) {
      expect(families).toContain(family);
    }
  });
});

describe("the Worker's Fraunces is the display cut", () => {
  it("has opsz, SOFT and WONK pinned and wght still variable", () => {
    // resvg 2.6.2 ignores `font-variation-settings` and renders a variable
    // font at its fvar DEFAULTS, so the axes the design needs have to be
    // instanced in ahead of time — except `wght`, which resvg DOES honour via
    // `font-weight` and which the card varies. If someone re-copies the
    // browser's `Fraunces-VF.ttf` over these, the card silently reverts to
    // the opsz-9 text cut and every line also mis-wraps, because the advance
    // table in `text.ts` was measured against the display cut.
    for (const file of ["Fraunces-Display-VF.ttf", "Fraunces-Display-Italic-VF.ttf"]) {
      const axes = fvarAxes(readFont(FONT_DIR, file));
      expect(axes.map((a) => a.tag)).toEqual(["wght"]);
      expect(axes[0]?.min).toBe(100);
      expect(axes[0]?.max).toBe(900);
    }
  });

  it("is not byte-identical to the browser's copy", () => {
    // A blunt guard against the obvious "tidy-up": deleting the Worker's
    // fonts and pointing at `apps/web/public/fonts` instead. That builds, it
    // renders, and it is wrong.
    expect(readFont(FONT_DIR, "Fraunces-Display-VF.ttf").equals(readFont(WEB_FONT_DIR, "Fraunces-VF.ttf"))).toBe(false);
  });
});

describe("the Courier Prime copies", () => {
  it("are byte-identical to the ones the browser gets", () => {
    // Unlike Fraunces, Courier Prime is not variable and needs no instancing,
    // so `apps/api/src/og/fonts/` holds a straight copy — and a copy can
    // drift. If someone updates the browser's Courier and not this one, the
    // card's captions render in a different cut than the app's, which is
    // exactly the kind of difference nobody files a bug about. Bundling
    // rather than reading through the ASSETS binding is deliberate (see
    // `src/og/fonts.ts`); this is the cost of that choice, made visible.
    for (const file of ["CourierPrime-Regular.ttf", "CourierPrime-Bold.ttf"]) {
      expect(readFont(FONT_DIR, file).equals(readFont(WEB_FONT_DIR, file))).toBe(true);
    }
  });
});

/** Minimal `fvar` reader: the axis tags and their min/max. */
function fvarAxes(bytes: Buffer): { tag: string; min: number; max: number }[] {
  const numTables = bytes.readUInt16BE(4);
  let fvar = -1;
  for (let i = 0; i < numTables; i += 1) {
    const rec = 12 + i * 16;
    if (bytes.toString("ascii", rec, rec + 4) === "fvar") {
      fvar = bytes.readUInt32BE(rec + 8);
      break;
    }
  }
  if (fvar < 0) return [];
  const axesArrayOffset = fvar + bytes.readUInt16BE(fvar + 4);
  const axisCount = bytes.readUInt16BE(fvar + 8);
  const axisSize = bytes.readUInt16BE(fvar + 10);
  const axes: { tag: string; min: number; max: number }[] = [];
  for (let i = 0; i < axisCount; i += 1) {
    const at = axesArrayOffset + i * axisSize;
    axes.push({
      tag: bytes.toString("ascii", at, at + 4),
      min: bytes.readInt32BE(at + 4) / 65536,
      max: bytes.readInt32BE(at + 12) / 65536,
    });
  }
  return axes;
}

#!/usr/bin/env node
/**
 * Regenerates the Fraunces advance table in `apps/api/src/og/text.ts`.
 *
 * The share card decides its own line breaks in JavaScript, because resvg
 * rasterises an SVG and will not tell you how wide the text came out. That
 * needs advance widths, and the first version of this guessed them by
 * character class — which measured 10-24% low and made the title's clip-path
 * backstop engage on ordinary long titles instead of never firing.
 *
 * So: measure them off the real font, through the real renderer.
 *
 * For each character it rasterises one copy and nine copies, and takes
 * `(ink(9) - ink(1)) / 8`. Differencing two runs of the same glyph cancels
 * the leading side bearing of the first and the trailing side bearing of the
 * last, which is what makes an ink-extent measurement yield an *advance*
 * rather than a bounding box.
 *
 * Run it when `Fraunces-VF.ttf` changes, when the title's weight changes, or
 * when resvg is upgraded (a version with real `font-variation-settings`
 * support would render a different optical cut and therefore different
 * advances). Prints the two literals to paste into `text.ts`; it does not
 * edit the file, because the surrounding comment explains provenance that a
 * codegen marker would lose.
 *
 * Usage:  node tools/og/measure-advances.mjs [weight]      (default: 600)
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initWasm, Resvg } from "@resvg/resvg-wasm";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WEIGHT = Number(process.argv[2] ?? 600);

/** Large enough that a rounded pixel measurement is a rounding error. */
const SIZE = 100;
const REPEATS = 9;

await initWasm(readFileSync(join(REPO, "node_modules/@resvg/resvg-wasm/index_bg.wasm")));

// The fonts the WORKER loads, not the ones the browser loads. Measuring
// against `apps/web/public/fonts/Fraunces-VF.ttf` would produce a table for
// the opsz-9 text cut, while the card renders in the opsz-144 display cut —
// different advances, silently wrong wrapping. See `apps/api/src/og/fonts.ts`.
const fontBuffers = [
  join(REPO, "apps/api/src/og/fonts/Fraunces-Display-VF.ttf"),
  join(REPO, "apps/api/src/og/fonts/Fraunces-Display-Italic-VF.ttf"),
  join(REPO, "apps/web/public/fonts/CourierPrime-Regular.ttf"),
  join(REPO, "apps/web/public/fonts/CourierPrime-Bold.ttf"),
].map((f) => new Uint8Array(readFileSync(f)));

function inkWidth(text) {
  const W = 8000;
  const H = 240;
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&apos;")
    .replace(/"/g, "&quot;");
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="#fff"/><text x="20" y="150" font-family="Fraunces" font-weight="${WEIGHT}" font-size="${SIZE}" fill="#000">${esc}</text></svg>`;
  const im = new Resvg(svg, { font: { fontBuffers, defaultFontFamily: "Fraunces", loadSystemFonts: false } }).render();
  const px = im.pixels;
  let right = -1;
  for (let y = 0; y < im.height; y += 1) {
    const row = y * im.width * 4;
    for (let x = im.width - 1; x > right; x -= 1) {
      if (px[row + x * 4] < 200) {
        right = x;
        break;
      }
    }
  }
  return right < 0 ? 0 : right - 20 + 1;
}

const chars = [];
for (let cp = 0x20; cp <= 0x7e; cp += 1) chars.push(String.fromCharCode(cp));
// The non-ASCII the card actually admits: `isRenderable` allows Latin-1 /
// Latin Extended and General Punctuation, and `wrapText` itself inserts "…".
chars.push("’", "‘", "“", "”", "—", "–", "…", "é", "è", "ü", "ö", "á", "ñ", "ç", "É");

const advances = new Map();
for (const ch of chars) {
  if (ch === " ") {
    // A space has no ink of its own; measure it as the gap it opens between
    // two glyphs that do.
    advances.set(ch, (inkWidth("n n") - inkWidth("nn")) / SIZE);
    continue;
  }
  advances.set(ch, (inkWidth(ch.repeat(REPEATS)) - inkWidth(ch)) / (REPEATS - 1) / SIZE);
}

const sorted = [...advances.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
const values = sorted.map(([, v]) => Number(v.toFixed(3)));
const median = [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

const rows = [];
for (let i = 0; i < values.length; i += 12) {
  rows.push(`  ${values.slice(i, i + 12).map((v) => String(v)).join(", ")},`);
}

console.log(`// Fraunces @ wght ${WEIGHT}, measured ${new Date().toISOString().slice(0, 10)}\n`);
console.log(`const FRAUNCES_CHARS = ${JSON.stringify(sorted.map(([k]) => k).join(""))};`);
console.log("const FRAUNCES_ADVANCES = [");
console.log(rows.join("\n"));
console.log("];");
console.log(`const FRAUNCES_FALLBACK = ${median};`);

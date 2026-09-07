#!/usr/bin/env node
/**
 * Offline preview harness for the share card (PR 0, the design spike).
 *
 * Renders every composition in `apps/api/src/og/card.ts` across a fixture
 * matrix and prints a byte table, so a composition can be chosen by looking
 * at real cards rather than at a description of them.
 *
 * ## Why this bundles instead of importing
 *
 * The point of this harness is that what you look at is what production will
 * emit — not a re-implementation that agrees with it today and drifts next
 * month. So it renders through the *same* `buildItemCardSvg` the Worker calls
 * and the *same* renderer (`@resvg/resvg-wasm`), at the same version.
 *
 * It can't `import()` the module directly: `apps/api` is NodeNext, so its
 * internal specifiers are written `./text.js` for a file that only exists as
 * `text.ts`, and Node's type stripping resolves specifiers literally. esbuild
 * (already present, it is what wrangler bundles the Worker with) resolves and
 * strips in one step, which is both correct and closer to what ships.
 *
 * ## What is NOT identical to production
 *
 * The photos. R2 holds real camera JPEGs; these fixtures are synthetic, and
 * deliberately *harder* to compress than a photograph — a plasma field plus
 * per-pixel grain, JPEG'd at the same q0.85 the client uses
 * (`apps/web/src/lib/images/resizeImage.ts`). So the byte column below is a
 * conservative upper bound, not an estimate. The real-photo check is the e2e
 * assertion in `apps/web/e2e/give.spec.ts`.
 *
 * Usage:
 *   node tools/og/render-samples.mjs [outDir]      (default: /tmp/ks-og-samples)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import { build } from "esbuild";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import jpeg from "jpeg-js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = process.argv[2] ?? "/tmp/ks-og-samples";

/* ------------------------------------------------------------------ *
 * A minimal PNG encoder, so the fixtures need no image library.
 * Same construction as apps/web/e2e/support/png.ts, different pixels.
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = -1;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * A deterministic plasma field with grain. Smooth large-scale structure (like
 * a photographed object and its shadow) plus high-frequency noise (like film
 * grain and JPEG texture) — the combination that actually costs bytes.
 */
function photoLikePng(width, height, seed) {
  let rng = seed * 2654435761;
  const rand = () => {
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
    return rng / 0xffffffff;
  };
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const u = x / width;
      const v = y / height;
      const plasma =
        Math.sin((u + seed * 0.13) * 7.1) * Math.cos((v - seed * 0.07) * 5.3) +
        Math.sin((u * 2.3 + v * 3.1 + seed) * 4.7) * 0.6;
      const base = 128 + plasma * 52;
      const at = row + 1 + x * 3;
      raw[at] = Math.max(0, Math.min(255, base + 26 + (rand() - 0.5) * 34)) | 0;
      raw[at + 1] = Math.max(0, Math.min(255, base + 4 + (rand() - 0.5) * 34)) | 0;
      raw[at + 2] = Math.max(0, Math.min(255, base - 22 + (rand() - 0.5) * 34)) | 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** PNG -> JPEG q85 via `sips`, matching the client's canvas encode exactly. */
function toJpeg(png, tmpBase) {
  const pngPath = `${tmpBase}.png`;
  const jpgPath = `${tmpBase}.jpg`;
  writeFileSync(pngPath, png);
  execFileSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "85", pngPath, "--out", jpgPath], {
    stdio: "ignore",
  });
  const jpeg = readFileSync(jpgPath);
  rmSync(pngPath, { force: true });
  rmSync(jpgPath, { force: true });
  return jpeg;
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const LONG_STORY =
  "My grandmother kept this on the windowsill above her kitchen sink for thirty-one years, " +
  "where it caught the morning light and slowly went from white to the colour of weak tea. " +
  "She used it every single day for her first cup, and when she died my mother wrapped it in " +
  "newspaper and put it in a box that moved house four times without ever being opened. " +
  "I have carried it through three apartments now and I have never once drunk from it, which " +
  "feels like the wrong way to treat something that was so thoroughly used. It deserves a " +
  "kitchen with a window and somebody who takes their tea in the morning. There is a hairline " +
  "crack running down from the rim on the handle side that has been there as long as I can " +
  "remember and has never leaked, and a small chip on the foot that you only see upside down.";

const FIXTURES = [
  {
    key: "portrait",
    note: "3:4 portrait, short title — the common case",
    photo: [900, 1200],
    input: {
      id: "01JQ8ZK3PORTRAIT0000000001",
      title: "Grandmother's teacup",
      story: LONG_STORY,
      categoryLabel: "Home & kitchen",
      place: "Somerville, MA",
      status: "approved",
      hasSecondPhoto: true,
    },
  },
  {
    key: "landscape",
    note: "4:3 landscape, two-line title",
    photo: [1200, 900],
    input: {
      id: "01JQ8ZK3LANDSCAPE000000002",
      title: "Hand-planed oak bookshelf from a workshop in Vermont",
      story: LONG_STORY,
      categoryLabel: "Furniture & decor",
      place: "Burlington, VT",
      status: "approved",
      hasSecondPhoto: true,
    },
  },
  {
    key: "square",
    note: "1:1 square — the window-ratio edge",
    photo: [1000, 1000],
    input: {
      id: "01JQ8ZK3SQUARE00000000003",
      title: "Brass sextant, unrestored",
      story: "Bought at a house clearance in 1998 and never once taken to sea. The case is split.",
      categoryLabel: "Other",
      place: "Portland, ME",
      status: "approved",
      hasSecondPhoto: false,
    },
  },
  {
    key: "torture",
    note: "80-char title + 2000-char story — the truncation torture test",
    photo: [1100, 1000],
    input: {
      id: "01JQ8ZK3TORTURE00000000004",
      title: "A completely absurd and unreasonably long keepsake title of exactly eighty ch",
      story: LONG_STORY + " " + LONG_STORY,
      categoryLabel: "Photos, art & handmade",
      place: "San Luis Obispo, CA",
      status: "approved",
      hasSecondPhoto: true,
    },
  },
  {
    key: "given",
    note: "given status — the stamp swap",
    photo: [900, 1200],
    input: {
      id: "01JQ8ZK3GIVEN0000000000005",
      title: "Wooden spoon, worn on one side",
      story: "Thirty years of stirring. The bowl is worn flat where a right hand held it.",
      categoryLabel: "Home & kitchen",
      place: "Ithaca, NY",
      status: "given",
      hasSecondPhoto: false,
    },
  },
];

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

async function loadCardModule() {
  const outfile = join(OUT, ".card.bundle.mjs");
  await build({
    entryPoints: [join(REPO, "apps/api/src/og/card.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    logLevel: "warning",
  });
  return import(pathToFileURL(outfile).href);
}

function loadFonts() {
  // PR 0 renders with the fonts as they ship to the browser. resvg 2.6.2 has
  // no `font-variation-settings` support, so Fraunces comes out at its fvar
  // defaults (opsz 9 / SOFT 0) — the text cut, not the display cut. PR 1
  // replaces these with instanced cuts; until then this is exactly what the
  // Worker would render, which is the property that matters here.
  const dir = join(REPO, "apps/web/public/fonts");
  return [
    "Fraunces-VF.ttf",
    "Fraunces-Italic-VF.ttf",
    "CourierPrime-Regular.ttf",
    "CourierPrime-Bold.ttf",
    "CourierPrime-Italic.ttf",
  ].map((f) => new Uint8Array(readFileSync(join(dir, f))));
}

/**
 * The card ships as JPEG, not PNG — measured, not assumed. At 1200x630 with a
 * real photograph in the window, the same card is 377-536 KB as a PNG and
 * 87-89 KB as a q82 JPEG. PNG is simply the wrong container for a
 * photographic image, and the difference is the whole WhatsApp byte budget.
 * `rendered.pixels` gives the raw RGBA straight out of resvg, so the PNG
 * encode is skipped entirely rather than done and thrown away.
 */
const CARD_JPEG_QUALITY = 82;

async function main() {
  mkdirSync(OUT, { recursive: true });
  const { buildItemCardSvg, COVER_HREF, SECOND_HREF } = await loadCardModule();
  await initWasm(readFileSync(join(REPO, "node_modules/@resvg/resvg-wasm/index_bg.wasm")));
  const fontBuffers = loadFonts();

  const rows = [];
  for (const fixture of FIXTURES) {
    const [pw, ph] = fixture.photo;
    const cover = toJpeg(photoLikePng(pw, ph, 3), join(OUT, `.cover-${fixture.key}`));
    const second = toJpeg(photoLikePng(640, 480, 9), join(OUT, `.second-${fixture.key}`));

    for (const variant of ["a", "b", "c"]) {
      const svg = buildItemCardSvg(fixture.input, variant);
      const resvg = new Resvg(svg, {
        font: { fontBuffers, defaultFontFamily: "Fraunces", loadSystemFonts: false },
      });
      for (const href of resvg.imagesToResolve()) {
        if (href === COVER_HREF) resvg.resolveImage(href, cover);
        else if (href === SECOND_HREF) resvg.resolveImage(href, second);
      }
      const rendered = resvg.render();
      const { data } = jpeg.encode(
        { data: rendered.pixels, width: rendered.width, height: rendered.height },
        CARD_JPEG_QUALITY,
      );
      const name = `${variant}-${fixture.key}.jpg`;
      writeFileSync(join(OUT, name), data);
      rows.push({ name, variant, fixture: fixture.key, bytes: data.length, dims: `${rendered.width}x${rendered.height}` });
    }
  }

  rmSync(join(OUT, ".card.bundle.mjs"), { force: true });

  const BUDGET = 300_000;
  console.log(`\n  ${OUT}\n`);
  console.log("  file                    dims       bytes     budget");
  console.log("  ────────────────────────────────────────────────────");
  for (const r of rows) {
    const kb = `${(r.bytes / 1024).toFixed(0)} KB`;
    const flag = r.bytes <= BUDGET ? "ok" : "OVER";
    console.log(`  ${r.name.padEnd(22)}  ${r.dims.padEnd(9)}  ${kb.padStart(7)}   ${flag}`);
  }
  const worst = rows.reduce((a, b) => (a.bytes > b.bytes ? a : b));
  console.log("  ────────────────────────────────────────────────────");
  console.log(`  worst: ${worst.name} at ${(worst.bytes / 1024).toFixed(0)} KB (budget 293 KB)\n`);
  for (const variant of ["a", "b", "c"]) {
    const of = rows.filter((r) => r.variant === variant);
    const avg = of.reduce((s, r) => s + r.bytes, 0) / of.length;
    console.log(`  composition ${variant.toUpperCase()}: avg ${(avg / 1024).toFixed(0)} KB, worst ${(Math.max(...of.map((r) => r.bytes)) / 1024).toFixed(0)} KB`);
  }
  console.log("");
}

await main();

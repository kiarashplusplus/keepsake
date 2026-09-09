#!/usr/bin/env node
/**
 * Renders the two square icons the site declares from the one SVG source,
 * `apps/site/og/favicon.svg` — the same tilted print with a red stamp dot
 * that `apps/web/public/favicon.png` is.
 *
 *   apps/web/public/icon-512.png          512x512, transparent corners
 *   apps/web/public/apple-touch-icon.png  180x180, square (opaque)
 *
 * Why two files and not `favicon.png` scaled up: the 64px favicon is too
 * small for either job. Google's Organization `logo` guidance wants at least
 * 112x112 — which is why the root JSON-LD in `apps/web/app/+html.tsx`
 * carried no `logo` at all until this file existed, since a `logo` Google
 * rejects is worse than none — and iOS reads `apple-touch-icon` at 180x180.
 * The Apple one is rendered without the SVG's rounded corners: iOS applies
 * its own mask, and a transparent corner under that mask paints black.
 *
 * Through `@resvg/resvg-wasm`, the same renderer the Worker uses for the
 * share card, so what is on disk is reproducible from source rather than
 * from whichever desktop tool last exported it. Both outputs are committed;
 * this is run by hand when the SVG changes, not by the build.
 *
 * Usage:  node tools/og/render-icons.mjs
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initWasm, Resvg } from "@resvg/resvg-wasm";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = resolve(REPO, "apps/site/og/favicon.svg");
const OUT_DIR = resolve(REPO, "apps/web/public");

const require = createRequire(import.meta.url);
await initWasm(readFileSync(require.resolve("@resvg/resvg-wasm/index_bg.wasm")));

const svg = readFileSync(SOURCE, "utf8");
if (!svg.includes('rx="8"')) {
  throw new Error(
    `${SOURCE} no longer has the rounded corner this script strips for the Apple icon`,
  );
}

function render(markup, size, file) {
  const png = new Resvg(markup, { fitTo: { mode: "width", value: size } }).render().asPng();
  writeFileSync(resolve(OUT_DIR, file), png);
  // PNG IHDR: width at byte 16, height at 20.
  const width = Buffer.from(png).readUInt32BE(16);
  const height = Buffer.from(png).readUInt32BE(20);
  if (width !== size || height !== size)
    throw new Error(`${file}: rendered ${width}x${height}, wanted ${size}x${size}`);
  console.log(`[render-icons] ${file}: ${width}x${height}, ${png.length} bytes`);
}

render(svg, 512, "icon-512.png");
render(svg.replace('rx="8"', 'rx="0"'), 180, "apple-touch-icon.png");

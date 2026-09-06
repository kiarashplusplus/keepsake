#!/usr/bin/env node
// Emits `dist/version.json` next to the exported static shell (`dist/index.html`)
// with `{ commit, builtAt }`. MUST run AFTER `expo export --platform web`
// (the `export` script in package.json chains the two). Reuses
// `resolveCommitHash()` from `./resolveBuildInfo.mjs` — the SAME function
// `app.config.js` uses for `expo.extra.buildInfo.commitHash` — so a future
// version-skew guard compares two independently-computed-but-identical
// values rather than two that can silently drift (see resolveBuildInfo.mjs
// header comment; pattern from finderly-monorepo
// frontend/scripts/write-version-json.js).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCommitHash, resolveBuildDate } from "./resolveBuildInfo.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, "..", "dist");
const INDEX_HTML_PATH = path.join(DIST_DIR, "index.html");
const OUTPUT_PATH = path.join(DIST_DIR, "version.json");

function main() {
  if (!fs.existsSync(INDEX_HTML_PATH)) {
    console.error(
      `[write-version-json] ${INDEX_HTML_PATH} not found — run "expo export --platform web" first.`,
    );
    process.exit(1);
  }

  const payload = { commit: resolveCommitHash(), builtAt: resolveBuildDate() };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload));
  console.log(`[write-version-json] wrote ${OUTPUT_PATH}:`, payload);
}

main();

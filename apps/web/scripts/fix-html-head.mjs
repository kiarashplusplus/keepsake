#!/usr/bin/env node
/**
 * Removes empty `<title>` elements from the exported HTML.
 *
 * `expo export` writes react-helmet's placeholder — `<title data-rh="true">`
 * with nothing inside — *above* the real `<title>Keepsake</title>` that
 * `app/+html.tsx` provides. Browsers use the first title in `<head>`, so every
 * route shipped a blank tab title, a blank bookmark name and a blank unfurl
 * title. Only `/item/:id` escaped it, because the Worker's OG rewriter strips
 * every title and appends its own.
 *
 * Caught by the axe `document-title` check in the Playwright suite.
 *
 * Build time rather than request time: it is deterministic, costs nothing per
 * request, and only ever removes a title that is genuinely empty — a real
 * per-route title set through `expo-router/head` later will survive.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const dist = resolve(new URL(".", import.meta.url).pathname, "../dist");

/** `<title ...></title>` containing nothing but whitespace. */
const EMPTY_TITLE = /<title\b[^>]*>\s*<\/title>/gi;

function htmlFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...htmlFiles(p));
    else if (name.endsWith(".html")) out.push(p);
  }
  return out;
}

const files = htmlFiles(dist);
if (files.length === 0) {
  console.error("[fix-html-head] no HTML found in dist — did the export run?");
  process.exit(1);
}

let changed = 0;
const stillEmpty = [];
for (const file of files) {
  const before = readFileSync(file, "utf8");
  const after = before.replace(EMPTY_TITLE, "");
  if (after !== before) {
    writeFileSync(file, after);
    changed += 1;
  }
  // Every page must end up with a non-empty title, whichever produced it.
  if (!/<title\b[^>]*>\s*\S[\s\S]*?<\/title>/i.test(after)) {
    stillEmpty.push(relative(dist, file));
  }
}

if (stillEmpty.length > 0) {
  console.error(`[fix-html-head] no usable <title> in: ${stillEmpty.join(", ")}`);
  process.exit(1);
}

console.log(`[fix-html-head] ${files.length} page(s), stripped an empty title from ${changed}`);

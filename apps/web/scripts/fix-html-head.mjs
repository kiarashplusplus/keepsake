#!/usr/bin/env node
/**
 * Removes empty `<title>` elements from the exported HTML, and — on a route
 * that renders a real one via `expo-router/head` (`RouteHead`) — the now-
 * redundant static default too.
 *
 * `expo export` writes react-helmet's placeholder — `<title data-rh="true">`
 * with nothing inside — *above* the real `<title>Keepsake</title>` that
 * `app/+html.tsx` provides. Browsers use the first title in `<head>`, so a
 * route with no `RouteHead` of its own shipped a blank tab title, a blank
 * bookmark name and a blank unfurl title. Only `/item/:id` escaped it,
 * because the Worker's OG rewriter strips every title and appends its own.
 *
 * A route that DOES render `RouteHead` (most of them, as of the per-route
 * metadata pass — see `src/ui/RouteHead.tsx`) flips the problem: react-
 * helmet's placeholder now carries the real title/description, injected
 * *before* `app/+html.tsx`'s static ones rather than replacing them, so the
 * page ends up with two non-empty `<title>` tags and two `<meta
 * name="description">` tags. Browsers still take the first — the tab title
 * was never wrong — but shipping a second, stale `<title>Keepsake</title>`
 * a few tags later is exactly the kind of thing this script exists to keep
 * out of `dist/`, so the static one is dropped whenever a real
 * `data-rh="true"` one is present to replace it.
 *
 * Caught by the axe `document-title` check in the Playwright suite.
 *
 * Build time rather than request time: it is deterministic and costs
 * nothing per request.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const dist = resolve(new URL(".", import.meta.url).pathname, "../dist");

/** `<title ...></title>` containing nothing but whitespace. */
const EMPTY_TITLE = /<title\b[^>]*>\s*<\/title>/gi;

/** A real (non-empty) react-helmet title/description — present only on a
 * route that renders `RouteHead`. */
const REAL_RH_TITLE = /<title data-rh="true">[^<]+<\/title>/;
const REAL_RH_DESCRIPTION = /<meta data-rh="true" name="description"[^>]*\/>/;

/** The static default `app/+html.tsx` bakes into every page's shell — no
 * `data-rh` attribute, since it isn't react-helmet's doing. Only stripped
 * once a `REAL_RH_*` match above confirms there's a real one to fall back
 * to; on a route with no `RouteHead` (the feed, `/item/:id`, `+not-found`),
 * this stays — it's the only title the page has. */
const STATIC_TITLE = /<title>[^<]*<\/title>/;
const STATIC_DESCRIPTION = /<meta name="description"[^>]*\/>/;

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

let strippedEmpty = 0;
let strippedDuplicate = 0;
const stillEmpty = [];
for (const file of files) {
  const before = readFileSync(file, "utf8");
  let after = before.replace(EMPTY_TITLE, "");
  if (after !== before) strippedEmpty += 1;

  const hasRealTitle = REAL_RH_TITLE.test(after);
  const withoutStaticTitle = hasRealTitle ? after.replace(STATIC_TITLE, "") : after;
  const hasRealDescription = REAL_RH_DESCRIPTION.test(withoutStaticTitle);
  const withoutStaticDescription = hasRealDescription ? withoutStaticTitle.replace(STATIC_DESCRIPTION, "") : withoutStaticTitle;
  if (withoutStaticDescription !== after) strippedDuplicate += 1;
  after = withoutStaticDescription;

  if (after !== before) writeFileSync(file, after);
  // Every page must end up with exactly one non-empty title, whichever
  // produced it.
  if (!/<title\b[^>]*>\s*\S[\s\S]*?<\/title>/i.test(after)) {
    stillEmpty.push(relative(dist, file));
  }
}

if (stillEmpty.length > 0) {
  console.error(`[fix-html-head] no usable <title> in: ${stillEmpty.join(", ")}`);
  process.exit(1);
}

console.log(
  `[fix-html-head] ${files.length} page(s), stripped an empty title from ${strippedEmpty}, a duplicate static title/description from ${strippedDuplicate}`,
);

// Copies the static marketing pages (apps/site/public/*) into dist/ after
// `expo export`. Never overwrites: the app owns `/`, `/give`, `/mine`,
// `/item/*` and its own hashed assets; the site owns `/about`, `/privacy`,
// `/terms`, `site.css`, `og-default.png`. A collision is a bug, so it fails loudly.
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const here = resolve(new URL(".", import.meta.url).pathname);
const src = resolve(here, "../../site/public");
const dist = resolve(here, "../dist");

if (!existsSync(src)) {
  console.log(`[copy-site] ${src} not present, skipping`);
  process.exit(0);
}
if (!existsSync(dist)) {
  console.error(`[copy-site] ${dist} missing — run expo export first`);
  process.exit(1);
}

const collisions = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (existsSync(join(dist, relative(src, p)))) collisions.push(relative(src, p));
  }
}
walk(src);
if (collisions.length) {
  console.error(`[copy-site] refusing to overwrite app output:\n  ${collisions.join("\n  ")}`);
  process.exit(1);
}
cpSync(src, dist, { recursive: true, errorOnExist: true, force: false });
console.log(`[copy-site] copied ${relative(process.cwd(), src)} → ${relative(process.cwd(), dist)}`);

// Substitute the public consent/ads ids into the copied HTML.
//
// The static pages load the same `/consent.js` the app does, and that file
// reads its ids from <meta> tags because it cannot see `process.env`. The app
// gets them from `app/+html.tsx`; plain HTML has no build step of its own, so
// this is it. Doing it here rather than committing the ids keeps one source of
// truth (`.env.example`'s `EXPO_PUBLIC_*` block) for both surfaces.
//
// An unset variable leaves the literal `%NAME%` placeholder in place, which
// `consent.js` treats as "not configured" — the same kill switch an empty
// value gives the app, and what the standalone `apps/site/serve.mjs` preview
// always sees.
const SUBSTITUTIONS = ["EXPO_PUBLIC_GOOGLE_ADS_ID", "EXPO_PUBLIC_CF_WEB_ANALYTICS_TOKEN"];

function htmlFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...htmlFiles(p));
    else if (name.endsWith(".html")) out.push(p);
  }
  return out;
}

let substituted = 0;
for (const file of htmlFiles(src).map((p) => join(dist, relative(src, p)))) {
  const original = readFileSync(file, "utf8");
  let next = original;
  for (const name of SUBSTITUTIONS) {
    const value = (process.env[name] ?? "").trim();
    if (value) next = next.split(`%${name}%`).join(value);
  }
  if (next !== original) {
    writeFileSync(file, next, "utf8");
    substituted += 1;
  }
}
console.log(
  substituted === 0
    ? "[copy-site] no EXPO_PUBLIC_* ids set; static pages keep their placeholders (nothing third-party loads)"
    : `[copy-site] substituted public ids into ${substituted} page(s)`,
);

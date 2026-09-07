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
// always sees. That is fine locally and NOT fine on a deployed export, which
// is why `assertNoPlaceholders` below fails one; see its comment.
//
// `EXPO_PUBLIC_GOOGLE_ADS_ID` was in this list until 2026-09-07 and its
// placeholder shipped, unsubstituted, in every deployed static page — the
// variable was declared in `.env.example` and read by `config.ts` but passed
// by no deploy (#175). The ads plumbing is gone (Kiarash's decision: no
// Google Ads for now), so the placeholder has no source and the pages no
// longer carry the meta at all.
const SUBSTITUTIONS = ["EXPO_PUBLIC_CF_WEB_ANALYTICS_TOKEN"];

function htmlFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...htmlFiles(p));
    else if (name.endsWith(".html")) out.push(p);
  }
  return out;
}

const copiedPages = htmlFiles(src).map((p) => join(dist, relative(src, p)));

let substituted = 0;
for (const file of copiedPages) {
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

// A placeholder that survives into a DEPLOYED export is a shipped bug, not a
// kill switch (#175). `%EXPO_PUBLIC_GOOGLE_ADS_ID%` shipped literally in
// every production page for the life of that feature because the variable was
// declared and read but passed by no deploy, and nothing looked at the
// output. `verify-public-env.mjs` catches the same class one level up — it
// fails a deployed export when a name declared in `.env.example` is unset —
// but it reads the JS bundle, and these pages are not in it. So check the
// artifact that actually ships.
//
// Locally and in CI (`EXPO_PUBLIC_ENV` unset or `development`) an
// unsubstituted placeholder is the documented "not configured" state and is
// only reported, never fatal — `apps/site/serve.mjs`'s standalone preview
// never substitutes at all.
const PLACEHOLDER_RE = /%(EXPO_PUBLIC_[A-Z0-9_]+)%/g;
const envName = (process.env.EXPO_PUBLIC_ENV ?? "").trim();
const deployed = envName !== "" && envName !== "development";

const leftover = new Map(); // name -> [files]
for (const file of copiedPages) {
  for (const match of readFileSync(file, "utf8").matchAll(PLACEHOLDER_RE)) {
    if (!leftover.has(match[1])) leftover.set(match[1], []);
    const files = leftover.get(match[1]);
    const rel = relative(dist, file);
    if (!files.includes(rel)) files.push(rel);
  }
}

if (leftover.size === 0) {
  console.log(`[copy-site] no %EXPO_PUBLIC_*% placeholders survive in ${copiedPages.length} copied page(s)`);
} else {
  const described = [...leftover].map(([name, files]) => `${name} (${files.join(", ")})`).join("; ");
  if (deployed) {
    console.error(
      `[copy-site] unsubstituted placeholder(s) in a deployed export (EXPO_PUBLIC_ENV=${envName}): ${described}\n` +
        "  These ship to visitors as literal %NAME% text in the page source. Either pass the variable from\n" +
        "  .github/workflows/deploy.yml's \"Export web\" step, or remove the placeholder from apps/site/public/.",
    );
    process.exit(1);
  }
  console.log(`[copy-site] placeholders left unsubstituted (not a deployed export): ${described}`);
}

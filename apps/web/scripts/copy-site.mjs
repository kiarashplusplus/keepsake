// Copies the static marketing pages (apps/site/public/*) into dist/ after
// `expo export`. Never overwrites: the app owns `/`, `/give`, `/mine`,
// `/item/*` and its own hashed assets; the site owns `/about`, `/privacy`,
// `/terms`, `site.css`, `og-default.png`. A collision is a bug, so it fails loudly.
import { cpSync, existsSync, readdirSync, statSync } from "node:fs";
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

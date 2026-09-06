#!/usr/bin/env node
/**
 * Fails the build when an `EXPO_PUBLIC_*` value set in the environment did not
 * actually reach the bundle.
 *
 * Metro caches transformed modules, and `EXPO_PUBLIC_*` values are inlined at
 * transform time. Change a variable without clearing the cache and the export
 * silently reuses the old inlined value — the build is green and the artifact
 * is wrong. That is how the Turnstile site key came out as `""` on a build
 * where it was set: nothing failed, the bot check simply never rendered.
 *
 * `export` now passes `--clear`, so this should always pass. It stays because
 * the failure it catches is invisible: a wrong value looks exactly like a
 * correct one until someone opens the site.
 *
 * Only non-empty values are checked — an unset variable legitimately inlines
 * as empty.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const bundleDir = resolve(
  new URL(".", import.meta.url).pathname,
  "../dist/_expo/static/js/web",
);

let bundles;
try {
  bundles = readdirSync(bundleDir).filter((f) => f.endsWith(".js"));
} catch {
  console.error(`[verify-public-env] no bundle at ${bundleDir} — did the export run?`);
  process.exit(1);
}
if (bundles.length === 0) {
  console.error("[verify-public-env] no JS bundle found");
  process.exit(1);
}

const source = bundles.map((f) => readFileSync(join(bundleDir, f), "utf8")).join("");

const expected = Object.entries(process.env)
  .filter(([name, value]) => name.startsWith("EXPO_PUBLIC_") && (value ?? "").trim() !== "");

const missing = expected.filter(([, value]) => !source.includes(value));

if (missing.length > 0) {
  console.error(
    `[verify-public-env] set but absent from the bundle: ${missing.map(([n]) => n).join(", ")}\n` +
      "  The bundler cache is the usual cause. Re-run the export with --clear.",
  );
  process.exit(1);
}

console.log(
  expected.length === 0
    ? "[verify-public-env] no EXPO_PUBLIC_* values set; nothing to check"
    : `[verify-public-env] ${expected.length} value(s) present in the bundle`,
);

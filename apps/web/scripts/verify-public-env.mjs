#!/usr/bin/env node
/**
 * Fails the build when a declared `EXPO_PUBLIC_*` variable did not reach the
 * bundle — either because nobody passed it, or because it was passed and the
 * bundler inlined a stale value.
 *
 * ## Why the expectation set comes from `.env.example`, not `process.env`
 *
 * Issue #175. This guard was written after the Turnstile-site-key incident in
 * AGENTS.md's table — a build where the key was set and the bundle shipped
 * `""` anyway, green the whole time — and it was structurally blind to that
 * incident's own shape. It built `expected` by filtering `process.env`:
 *
 *     Object.entries(process.env).filter(([name, value]) =>
 *       name.startsWith("EXPO_PUBLIC_") && (value ?? "").trim() !== "")
 *
 * A name **absent** from the deploy step's `env:` block is absent from
 * `expected`, so it could never be reported missing. The check could only
 * verify variables that had already been passed correctly. `deploy.yml` set
 * four; `.env.example` declares seven; `config.ts` read all seven with
 * `?? ""`; and preflight's `env-parity` deliberately excludes `EXPO_PUBLIC_*`,
 * so nothing anywhere reconciled the two lists. Three Google Ads ids inlined
 * as `""` in every preview and production bundle, and nothing failed.
 *
 * So the declared list — `.env.example`'s `EXPO_PUBLIC_*` block — is the
 * expectation now. It is the one file that describes what the client bundle is
 * supposed to contain, and it is not written by whatever forgot the variable.
 *
 * ## What counts as a failure
 *
 * - **Declared but unset, on a deployed export** (`EXPO_PUBLIC_ENV` is
 *   anything other than empty or `development`). This is the case #175 is
 *   about. On a local or CI export with no `EXPO_PUBLIC_ENV`, an unset
 *   variable is normal and is reported as a note, not a failure.
 * - **Set but absent from the bundle.** Metro inlines `EXPO_PUBLIC_*` at
 *   transform time and caches transformed modules, so changing a value without
 *   clearing the cache silently reuses the old one. `export` passes `--clear`,
 *   so this should always pass; it stays because the failure is invisible from
 *   the outside.
 * - **Not inlined at all.** The old check asserted only `source.includes(value)`,
 *   which cannot fail for a low-entropy value: `EXPO_PUBLIC_ENV` is the literal
 *   string `preview`/`production`/`development`, certain to appear somewhere in
 *   a React Native web bundle whether or not the variable was inlined. So a
 *   surviving literal `process.env.EXPO_PUBLIC_<NAME>` in the bundle is now a
 *   failure in its own right: that reference is what inlining *removes*, and
 *   unlike the value it cannot be there by coincidence.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const scriptDir = new URL(".", import.meta.url).pathname;
const bundleDir = resolve(scriptDir, "../dist/_expo/static/js/web");
const envExamplePath = resolve(scriptDir, "../../../.env.example");

const fail = (message) => {
  console.error(`[verify-public-env] ${message}`);
  process.exit(1);
};

// ── The declared list ──────────────────────────────────────────────────

/** Every `EXPO_PUBLIC_*` name `.env.example` declares, in file order.
 * Commented-out lines do not count — a declaration has to be a declaration. */
function declaredPublicNames(text) {
  const names = [];
  for (const match of text.matchAll(/^[ \t]*(EXPO_PUBLIC_[A-Z0-9_]+)[ \t]*=/gm)) {
    if (!names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

let envExample;
try {
  envExample = readFileSync(envExamplePath, "utf8");
} catch {
  fail(`cannot read ${envExamplePath} — the declared EXPO_PUBLIC_* list is what this check verifies against, so it cannot run without it`);
}

const declared = declaredPublicNames(envExample);
if (declared.length === 0) {
  // The #166 lesson, applied here: "I found nothing to check" and "everything
  // is fine" must not look the same.
  fail(`.env.example declares no EXPO_PUBLIC_* names, so this check would verify nothing. That is a broken .env.example, not a clean bill of health.`);
}

// ── The bundle ─────────────────────────────────────────────────────────

let bundles;
try {
  bundles = readdirSync(bundleDir).filter((f) => f.endsWith(".js"));
} catch {
  fail(`no bundle at ${bundleDir} — did the export run?`);
}
if (bundles.length === 0) fail("no JS bundle found");

const source = bundles.map((f) => readFileSync(join(bundleDir, f), "utf8")).join("");

// ── Verify ─────────────────────────────────────────────────────────────

const envName = (process.env.EXPO_PUBLIC_ENV ?? "").trim();
const deployed = envName !== "" && envName !== "development";

const missingFromDeploy = [];
const absentFromBundle = [];
const notInlined = [];
const unsetLocally = [];
let present = 0;

for (const name of declared) {
  const value = (process.env[name] ?? "").trim();

  // The reference inlining removes. Present in the bundle => not inlined,
  // whatever the value looks like.
  if (source.includes(`process.env.${name}`)) notInlined.push(name);

  if (value === "") {
    if (deployed) missingFromDeploy.push(name);
    else unsetLocally.push(name);
    continue;
  }
  if (!source.includes(value)) absentFromBundle.push(name);
  else present += 1;
}

const problems = [];
if (missingFromDeploy.length > 0) {
  problems.push(
    `declared in .env.example but unset on a deployed export (EXPO_PUBLIC_ENV=${envName}): ${missingFromDeploy.join(", ")}\n` +
      "  Each one inlines as \"\" in the shipped bundle and whatever reads it is dead code.\n" +
      "  Fix by passing it from the GitHub Environment in .github/workflows/deploy.yml's\n" +
      "  \"Export web\" step, or by removing the declaration from .env.example and its reader.",
  );
}
if (absentFromBundle.length > 0) {
  problems.push(
    `set but absent from the bundle: ${absentFromBundle.join(", ")}\n` +
      "  The bundler cache is the usual cause. Re-run the export with --clear.",
  );
}
if (notInlined.length > 0) {
  problems.push(
    `still referenced as process.env.<NAME> in the bundle, so it was never inlined: ${notInlined.join(", ")}\n` +
      "  A value that merely appears somewhere in the bundle proves nothing; the reference\n" +
      "  disappearing is what proves the transform ran.",
  );
}

if (problems.length > 0) fail(problems.join("\n"));

const summary = [`${present} of ${declared.length} declared EXPO_PUBLIC_* value(s) present and inlined in the bundle`];
if (unsetLocally.length > 0) {
  summary.push(
    `  unset (not a deployed export, EXPO_PUBLIC_ENV=${envName || "<unset>"}): ${unsetLocally.join(", ")}`,
  );
}
console.log(`[verify-public-env] ${summary.join("\n")}`);

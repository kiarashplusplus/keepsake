/**
 * Guard: `EXPO_PUBLIC_*` env vars are baked verbatim into the web bundle at
 * build time (Expo's `babel-preset-expo` inlines them) — anything matching
 * that prefix is, by construction, public. This scans for the names used
 * anywhere in the app and fails if one looks like it's trying to smuggle a
 * secret through: matches `SECRET|PRIVATE|PASSWORD` outright, or matches
 * `TOKEN|KEY` without being on the small allowlist of names that are
 * legitimately public (a Turnstile *site* key and a CF Web Analytics
 * *beacon* token are both meant to be visible in the page source — that's
 * how those products work).
 *
 * Ported from the finderly-monorepo lesson: `EXPO_PUBLIC_*` baked into the
 * bundle means literally anyone can read it from view-source, forever (old
 * builds keep serving old bundles) — see build plan "Lessons carried in".
 */
import fs from "node:fs";
import path from "node:path";

const SCAN_ROOTS = ["app", "src"];
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"]);

const ALLOWLIST = new Set(["EXPO_PUBLIC_TURNSTILE_SITE_KEY", "EXPO_PUBLIC_CF_WEB_ANALYTICS_TOKEN"]);

const ENV_NAME_PATTERN = /EXPO_PUBLIC_[A-Z_]+/g;
const DISALLOWED_ALWAYS = /SECRET|PRIVATE|PASSWORD/;
const SENSITIVE_UNLESS_ALLOWED = /TOKEN|KEY/;

function collectFiles(absRoot: string, out: string[]): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absRoot);
  } catch {
    return;
  }
  if (stat.isFile()) {
    if (SCAN_EXTENSIONS.has(path.extname(absRoot))) out.push(absRoot);
    return;
  }
  for (const entry of fs.readdirSync(absRoot, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    collectFiles(path.join(absRoot, entry.name), out);
  }
}

describe("EXPO_PUBLIC_* naming guard", () => {
  const webRoot = path.resolve(__dirname, "..", "..");

  const files: string[] = [];
  for (const root of SCAN_ROOTS) collectFiles(path.join(webRoot, root), files);
  files.push(path.join(webRoot, "app.base.json"));
  files.push(path.join(webRoot, "app.config.js"));

  it("scans a non-empty set of files", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("finds no EXPO_PUBLIC_* name matching SECRET/PRIVATE/PASSWORD, or TOKEN/KEY off the allowlist", () => {
    const offenders: string[] = [];
    const seen = new Set<string>();

    for (const file of files) {
      let source: string;
      try {
        source = fs.readFileSync(file, "utf8");
      } catch {
        continue; // e.g. app.config.js / app.base.json may not exist in some configs
      }
      const matches = source.match(ENV_NAME_PATTERN) ?? [];
      for (const name of matches) {
        seen.add(name);
        const isBanned = DISALLOWED_ALWAYS.test(name) || (SENSITIVE_UNLESS_ALLOWED.test(name) && !ALLOWLIST.has(name));
        if (isBanned) offenders.push(`${path.relative(webRoot, file)}: ${name}`);
      }
    }

    if (offenders.length > 0) {
      throw new Error(
        `EXPO_PUBLIC_* names are baked into the client bundle verbatim — never a secret.\n` +
          `Offenders:\n${offenders.map((o) => `  ${o}`).join("\n")}`,
      );
    }
    expect(offenders).toEqual([]);
  });

  it("the pattern and banned-name logic actually discriminate (positive control)", () => {
    // Fresh non-global regex literal here on purpose: ENV_NAME_PATTERN carries
    // the `g` flag (needed for `.match()`'s find-all above), and `.test()` on
    // a global regex mutates its own `lastIndex`, corrupting later calls.
    expect(/EXPO_PUBLIC_[A-Z_]+/.test("EXPO_PUBLIC_SITE_URL")).toBe(true);
    expect(DISALLOWED_ALWAYS.test("EXPO_PUBLIC_API_SECRET")).toBe(true);
    expect(SENSITIVE_UNLESS_ALLOWED.test("EXPO_PUBLIC_ADMIN_TOKEN")).toBe(true);
    expect(ALLOWLIST.has("EXPO_PUBLIC_TURNSTILE_SITE_KEY")).toBe(true);
    expect(SENSITIVE_UNLESS_ALLOWED.test("EXPO_PUBLIC_SITE_URL")).toBe(false);
  });
});

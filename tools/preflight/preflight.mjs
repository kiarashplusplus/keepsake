#!/usr/bin/env node
// Keepsake preflight: checks that don't need a full pnpm install, a running
// Worker, or a device to answer. Modeled on Bayan's `tools/ci/preflight.py`
// (seconds-fast, testable checks with the *why* attached to every failure)
// but the monorepo here is being written by several agents at once — apps/web
// and apps/api do not exist in full yet. A check whose target directory is
// simply absent reports "skipped: <path> not present" rather than failing, so
// this is useful today (M0) and gets strict automatically as each path lands.
//
// Usage:
//   node tools/preflight/preflight.mjs [--list] [--only a,b] [--json] [--root <dir>]
//
// Exit status is 0 when every check passes (skips and warnings do not fail
// the build), 1 if any check fails.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ── Context: every check receives this, so tests can point it at a fixture
// tree instead of the real repo. ──────────────────────────────────────────

const IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".expo",
  ".wrangler",
  "coverage",
  "playwright-report",
  "test-results",
]);

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp",
  ".ttf", ".otf", ".woff", ".woff2",
  ".zip", ".sqlite", ".db", ".pdf", ".mp4", ".mov",
]);

export function createContext(root) {
  const abs = (relPath) => path.join(root, relPath);

  function exists(relPath) {
    return existsSync(abs(relPath));
  }

  function readText(relPath) {
    try {
      return readFileSync(abs(relPath), "utf8");
    } catch {
      return null;
    }
  }

  // Lists files (not directories) under `relDir`, relative to `root`,
  // skipping the standard build/VCS noise. Returns `[]` for a missing dir —
  // callers decide whether that means "skip" or "nothing to report".
  function walk(relDir) {
    const startRel = relDir === "." ? "" : relDir;
    const out = [];
    const recurse = (rel) => {
      const dirAbs = rel ? abs(rel) : root;
      let entries;
      try {
        entries = readdirSync(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (IGNORE_DIRS.has(entry.name)) continue;
          recurse(childRel);
        } else if (entry.isFile()) {
          out.push(childRel);
        }
      }
    };
    recurse(startRel);
    return out;
  }

  return { root, exists, readText, walk };
}

// ── Small parsers, kept dependency-free on purpose ────────────────────────

// Minimal TOML: section headers (`[vars]`, `[env.preview.vars]`) and
// `KEY = "value"` lines. `[[array.tables]]` headers reset the current
// section to null so their keys (e.g. `[[ratelimits]]` bindings) are never
// mistaken for `[vars]` entries. Good enough for wrangler.toml; not a
// general TOML parser.
export function parseToml(text) {
  const sections = {};
  let current = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^\[\[[^\]]+\]\]$/.test(line)) {
      current = null;
      continue;
    }
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      current = sectionMatch[1].trim();
      sections[current] ??= {};
      continue;
    }
    if (!current) continue;
    const kvMatch = line.match(/^([A-Za-z0-9_.]+)\s*=\s*(.+)$/);
    if (kvMatch) {
      sections[current][kvMatch[1]] = parseTomlValue(kvMatch[2]);
    }
  }
  return sections;
}

function parseTomlValue(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    if (end !== -1) return trimmed.slice(1, end);
  }
  const hashIndex = trimmed.indexOf("#");
  return (hashIndex !== -1 ? trimmed.slice(0, hashIndex) : trimmed).trim();
}

// `.env.example`: `NAME=` lines are vars; a `# secrets:` heading opens a
// block whose `NAME=` lines are secrets until the next blank line.
export function parseEnvExample(text) {
  const allNames = [];
  const secretNames = new Set();
  let inSecrets = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (/^#\s*secrets:/i.test(line)) {
      inSecrets = true;
      continue;
    }
    if (!line) {
      inSecrets = false;
      continue;
    }
    if (line.startsWith("#")) continue;
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (match) {
      allNames.push(match[1]);
      if (inSecrets) secretNames.add(match[1]);
    }
  }
  return { allNames, secretNames };
}

// ── Checks ─────────────────────────────────────────────────────────────

const HTML_PATH = "apps/web/app/+html.tsx";
const FONTS_DIR = "apps/web/public/fonts";

function checkFonts(ctx) {
  const html = ctx.readText(HTML_PATH);
  if (html === null) return { status: "skip", details: [`${HTML_PATH} not present`] };
  if (!ctx.exists(FONTS_DIR)) return { status: "skip", details: [`${FONTS_DIR} not present`] };

  const referenced = new Set();
  for (const match of html.matchAll(/url\(\s*["']?\/fonts\/([^"')]+)["']?\s*\)/g)) {
    referenced.add(match[1]);
  }

  const onDisk = new Set(
    ctx.walk(FONTS_DIR)
      .filter((f) => f.endsWith(".ttf"))
      .map((f) => path.posix.basename(f)),
  );

  const details = [];
  for (const file of [...referenced].sort()) {
    if (!onDisk.has(file)) {
      details.push(`fail: ${HTML_PATH} references /fonts/${file}, not found under ${FONTS_DIR}/`);
    }
  }
  const unreferenced = [...onDisk].filter((f) => !referenced.has(f)).sort();
  for (const file of unreferenced) {
    details.push(`warn: ${FONTS_DIR}/${file} is not referenced by any @font-face in ${HTML_PATH}`);
  }

  const hasFail = details.some((d) => d.startsWith("fail:"));
  if (hasFail) return { status: "fail", details };
  if (details.length > 0) return { status: "warn", details };
  return { status: "pass", details: [`${referenced.size} font(s) referenced, all present`] };
}

const MIGRATIONS_DIR = "apps/api/migrations";
const MIGRATION_NAME_RE = /^(\d+)_[A-Za-z0-9_]+\.sql$/;

function stripTrailingSqlComments(text) {
  let t = text.replace(/[ \t\r\n]+$/, "");
  for (;;) {
    const lastNewline = t.lastIndexOf("\n");
    const lastLine = lastNewline === -1 ? t : t.slice(lastNewline + 1);
    if (lastLine.trim().startsWith("--")) {
      t = (lastNewline === -1 ? "" : t.slice(0, lastNewline)).replace(/[ \t\r\n]+$/, "");
      continue;
    }
    break;
  }
  return t;
}

function checkMigrations(ctx) {
  if (!ctx.exists(MIGRATIONS_DIR)) return { status: "skip", details: [`${MIGRATIONS_DIR} not present`] };
  const files = ctx.walk(MIGRATIONS_DIR)
    .filter((f) => path.posix.dirname(f) === MIGRATIONS_DIR && f.endsWith(".sql"))
    .sort();

  if (files.length === 0) return { status: "skip", details: [`${MIGRATIONS_DIR} has no *.sql files yet`] };

  const details = [];
  const prefixToFiles = new Map();
  for (const file of files) {
    const base = path.posix.basename(file);
    const match = base.match(MIGRATION_NAME_RE);
    if (!match || match[1].length !== 4) {
      details.push(`${file}: name must be NNNN_slug.sql with a four-digit prefix`);
      continue;
    }
    const prefix = match[1];
    if (!prefixToFiles.has(prefix)) prefixToFiles.set(prefix, []);
    prefixToFiles.get(prefix).push(file);

    const text = ctx.readText(file) ?? "";
    if (!stripTrailingSqlComments(text).endsWith(";")) {
      details.push(`${file}: does not end with ';' (ignoring trailing whitespace/comments)`);
    }
  }

  for (const [prefix, group] of prefixToFiles) {
    if (group.length > 1) {
      details.push(`duplicate migration prefix ${prefix}: ${group.join(", ")}`);
    }
  }

  const numbers = [...prefixToFiles.keys()].map((p) => Number.parseInt(p, 10)).sort((a, b) => a - b);
  for (let i = 0; i < numbers.length; i += 1) {
    const expected = i + 1;
    if (numbers[i] !== expected) {
      details.push(
        `migration numbering has a gap or does not start at 0001: expected ${String(expected).padStart(4, "0")}, found ${numbers[i] !== undefined ? String(numbers[i]).padStart(4, "0") : "nothing"}`,
      );
      break;
    }
  }

  if (details.length > 0) return { status: "fail", details };
  return { status: "pass", details: [`${files.length} migration(s), 0001-contiguous`] };
}

const ENV_EXAMPLE_PATH = ".env.example";
const WRANGLER_PATH = "apps/api/wrangler.toml";

function checkEnvParity(ctx) {
  const envExampleText = ctx.readText(ENV_EXAMPLE_PATH);
  if (envExampleText === null) return { status: "skip", details: [`${ENV_EXAMPLE_PATH} not present`] };
  const wranglerText = ctx.readText(WRANGLER_PATH);
  if (wranglerText === null) return { status: "skip", details: [`${WRANGLER_PATH} not present`] };

  const { allNames, secretNames } = parseEnvExample(envExampleText);
  const backendVarNames = new Set(
    allNames.filter((n) => !secretNames.has(n) && !n.startsWith("EXPO_PUBLIC_")),
  );

  const toml = parseToml(wranglerText);
  const details = [];

  const groups = new Map();
  groups.set(ENV_EXAMPLE_PATH, backendVarNames);
  groups.set(`${WRANGLER_PATH} [vars]`, new Set(Object.keys(toml.vars ?? {})));

  const envSectionNames = Object.keys(toml)
    .map((s) => s.match(/^env\.([^.]+)\.vars$/))
    .filter(Boolean)
    .map((m) => m[1]);

  if (envSectionNames.length === 0) {
    details.push(`${WRANGLER_PATH}: no [env.<name>.vars] sections found (expected e.g. preview, production)`);
  }
  for (const envName of envSectionNames) {
    groups.set(`${WRANGLER_PATH} [env.${envName}.vars]`, new Set(Object.keys(toml[`env.${envName}.vars`])));
  }

  const allVarNames = new Set();
  for (const set of groups.values()) for (const n of set) allVarNames.add(n);

  for (const name of [...allVarNames].sort()) {
    const missingFrom = [...groups.entries()].filter(([, set]) => !set.has(name)).map(([label]) => label);
    if (missingFrom.length > 0) {
      details.push(`${name}: missing from ${missingFrom.join(", ")}`);
    }
  }

  for (const secret of [...secretNames].sort()) {
    for (const [label, set] of groups) {
      if (label === ENV_EXAMPLE_PATH) continue;
      if (set.has(secret)) {
        details.push(`${secret} is a secret (per "# secrets:" in ${ENV_EXAMPLE_PATH}) but appears in ${label} — use wrangler secret put instead`);
      }
    }
  }

  if (details.length > 0) return { status: "fail", details };
  return { status: "pass", details: [`${backendVarNames.size} var(s) consistent across .env.example and wrangler.toml (${envSectionNames.length} env block(s))`] };
}

const MODELS_PATH = "apps/api/src/models.ts";
const API_SRC_DIR = "apps/api/src";

function isTestFile(relPath) {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(relPath) || /(^|\/)(test|tests|__tests__)\//.test(relPath);
}

function checkModels(ctx) {
  if (!ctx.exists(API_SRC_DIR)) return { status: "skip", details: [`${API_SRC_DIR} not present`] };
  const files = ctx.walk(API_SRC_DIR).filter((f) => /\.(ts|tsx|js|mjs)$/.test(f));
  const details = [];
  let scanned = 0;
  for (const file of files) {
    if (file === MODELS_PATH || isTestFile(file)) continue;
    scanned += 1;
    const text = ctx.readText(file) ?? "";
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (line.includes("@cf/")) {
        details.push(`${file}:${i + 1}: "@cf/" model id literal outside ${MODELS_PATH}`);
      }
    });
  }
  if (details.length > 0) return { status: "fail", details };
  return { status: "pass", details: [`${scanned} file(s) scanned under ${API_SRC_DIR} (tests excluded)`] };
}

const PACKAGES_DIR = "packages";

function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(exportTargets);
  return [];
}

function checkExports(ctx) {
  if (!ctx.exists(PACKAGES_DIR)) return { status: "skip", details: [`${PACKAGES_DIR} not present`] };
  let pkgDirs;
  try {
    pkgDirs = readdirSync(path.join(ctx.root, PACKAGES_DIR), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    pkgDirs = [];
  }
  if (pkgDirs.length === 0) return { status: "skip", details: [`${PACKAGES_DIR} has no package directories yet`] };

  const details = [];
  let checked = 0;
  for (const dir of pkgDirs) {
    const pkgJsonRel = `${PACKAGES_DIR}/${dir}/package.json`;
    const text = ctx.readText(pkgJsonRel);
    if (text === null) continue;
    let pkg;
    try {
      pkg = JSON.parse(text);
    } catch (err) {
      details.push(`${pkgJsonRel}: invalid JSON (${err.message})`);
      continue;
    }
    checked += 1;
    const exportsField = pkg.exports;
    if (!exportsField || typeof exportsField !== "object") {
      details.push(`${pkgJsonRel}: has no "exports" object (subpath exports are required)`);
      continue;
    }
    if (Object.hasOwn(exportsField, ".")) {
      details.push(`${pkgJsonRel}: exports a "." barrel entry — subpaths only`);
    }
    for (const [key, value] of Object.entries(exportsField)) {
      if (key === ".") continue;
      for (const target of exportTargets(value)) {
        const targetRel = path.posix.join(`${PACKAGES_DIR}/${dir}`, target);
        if (!ctx.exists(targetRel)) {
          details.push(`${pkgJsonRel}: exports["${key}"] -> ${target} does not exist`);
        }
      }
    }
  }
  if (checked === 0) return { status: "skip", details: [`no package.json found under ${PACKAGES_DIR}/*`] };
  if (details.length > 0) return { status: "fail", details };
  return { status: "pass", details: [`${checked} package(s), no barrel exports, all subpath targets exist`] };
}

const WEB_APP_DIR = "apps/web/app";
const ROUTE_EXCLUDE_PLUS = new Set(["+html.tsx", "+not-found.tsx"]);

function checkRoutes(ctx) {
  if (!ctx.exists(WEB_APP_DIR)) return { status: "skip", details: [`${WEB_APP_DIR} not present`] };
  const files = ctx.walk(WEB_APP_DIR).filter((f) => f.endsWith(".tsx"));
  if (files.length === 0) return { status: "skip", details: [`${WEB_APP_DIR} has no .tsx routes yet`] };

  const details = [];
  let checked = 0;
  for (const file of files) {
    const base = path.posix.basename(file);
    if (base.startsWith("+") && !ROUTE_EXCLUDE_PLUS.has(base)) continue;
    checked += 1;
    const text = ctx.readText(file) ?? "";
    if (!/export\s+default\b/.test(text)) {
      details.push(`${file}: no "export default" (every route file, including _layout.tsx, needs one)`);
    }
  }
  if (details.length > 0) return { status: "fail", details };
  return { status: "pass", details: [`${checked} route file(s), all export default`] };
}

const CONFLICT_MARKER_RE = /^(<{7}|>{7})(\s|$)/;

function checkConflictMarkers(ctx) {
  const files = ctx.walk(".");
  let checked = 0;
  const details = [];
  for (const file of files) {
    if (BINARY_EXTENSIONS.has(path.posix.extname(file))) continue;
    const buf = (() => {
      try {
        return readFileSync(path.join(ctx.root, file));
      } catch {
        return null;
      }
    })();
    if (buf === null) continue;
    if (buf.includes(0)) continue; // binary
    checked += 1;
    const text = buf.toString("utf8");
    text.split("\n").forEach((line, i) => {
      if (CONFLICT_MARKER_RE.test(line)) {
        details.push(`${file}:${i + 1}: unresolved merge-conflict marker`);
      }
    });
  }
  if (details.length > 0) return { status: "fail", details };
  return { status: "pass", details: [`${checked} text file(s) scanned`] };
}

const SEEDS_DIR = "apps/api/seeds";
const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";

function checkLfsPointers(ctx) {
  if (!ctx.exists(SEEDS_DIR)) return { status: "skip", details: [`${SEEDS_DIR} not present`] };
  const files = ctx.walk(SEEDS_DIR).filter((f) => f.endsWith(".sql"));
  if (files.length === 0) return { status: "skip", details: [`${SEEDS_DIR} has no *.sql files yet`] };

  const details = [];
  for (const file of files) {
    const text = ctx.readText(file) ?? "";
    if (text.startsWith(LFS_POINTER_PREFIX)) {
      details.push(`${file}: unfetched LFS pointer — run: git lfs install && git lfs pull`);
    }
  }
  if (details.length > 0) return { status: "fail", details };
  return { status: "pass", details: [`${files.length} seed file(s), no unfetched LFS pointers`] };
}

const PUBLIC_ENV_RE = /EXPO_PUBLIC_[A-Z0-9_]+/g;
const PUBLIC_ENV_ALLOWLIST = new Set(["EXPO_PUBLIC_TURNSTILE_SITE_KEY", "EXPO_PUBLIC_CF_WEB_ANALYTICS_TOKEN"]);
const PUBLIC_ENV_TEXT_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".yml", ".yaml"]);

function checkPublicEnv(ctx) {
  const scanFiles = [];
  for (const dir of ["apps/web/app", "apps/web/src"]) {
    if (ctx.exists(dir)) {
      scanFiles.push(...ctx.walk(dir).filter((f) => PUBLIC_ENV_TEXT_EXT.has(path.posix.extname(f))));
    }
  }
  for (const file of ["apps/web/app.base.json", "apps/web/app.config.js"]) {
    if (ctx.exists(file)) scanFiles.push(file);
  }
  if (ctx.exists(".github/workflows")) {
    scanFiles.push(...ctx.walk(".github/workflows").filter((f) => /\.ya?ml$/.test(f)));
  }

  if (scanFiles.length === 0) return { status: "skip", details: ["no scannable paths present (apps/web/{app,src}, app.base.json, app.config.js, .github/workflows/*.yml)"] };

  const seen = new Map(); // name -> first file
  for (const file of scanFiles) {
    const text = ctx.readText(file) ?? "";
    for (const match of text.matchAll(PUBLIC_ENV_RE)) {
      if (!seen.has(match[0])) seen.set(match[0], file);
    }
  }

  const details = [];
  for (const [name, file] of seen) {
    if (/SECRET|PRIVATE|PASSWORD/.test(name)) {
      details.push(`${file}: ${name} looks like a secret but EXPO_PUBLIC_* is baked into the client bundle`);
    } else if (/TOKEN|KEY/.test(name) && !PUBLIC_ENV_ALLOWLIST.has(name)) {
      details.push(`${file}: ${name} matches TOKEN|KEY and is not in the allowlist (${[...PUBLIC_ENV_ALLOWLIST].join(", ")})`);
    }
  }
  if (details.length > 0) return { status: "fail", details };
  return { status: "pass", details: [`${seen.size} EXPO_PUBLIC_* name(s) across ${scanFiles.length} file(s), none look like secrets`] };
}

function checkShellSyntax(ctx) {
  const scripts = [...ctx.walk("tools"), ...ctx.walk(".github")].filter((f) => f.endsWith(".sh"));
  if (scripts.length === 0) return { status: "skip", details: ["no *.sh files under tools/ or .github/"] };

  const details = [];
  for (const script of scripts) {
    const result = spawnSync("bash", ["-n", path.join(ctx.root, script)], { encoding: "utf8" });
    if (result.status !== 0) {
      const lastLine = (result.stderr || "").trim().split("\n").pop();
      details.push(`${script}: ${lastLine || "bash -n failed"}`);
    }
  }
  if (details.length > 0) return { status: "fail", details };
  return { status: "pass", details: [`${scripts.length} shell script(s) parse`] };
}

export const CHECKS = {
  fonts: { description: "@font-face url(/fonts/*) vs apps/web/public/fonts/*.ttf", run: checkFonts },
  migrations: { description: "apps/api/migrations/NNNN_*.sql numbering and terminators", run: checkMigrations },
  "env-parity": { description: ".env.example vs wrangler.toml [vars] / [env.*.vars]", run: checkEnvParity },
  models: { description: '"@cf/" model ids confined to apps/api/src/models.ts', run: checkModels },
  exports: { description: "packages/*/package.json subpath exports (no \".\")", run: checkExports },
  routes: { description: "apps/web/app/**/*.tsx export a default component", run: checkRoutes },
  "conflict-markers": { description: "no unresolved <<<<<<< / >>>>>>> in tracked text", run: checkConflictMarkers },
  "lfs-pointers": { description: "apps/api/seeds/*.sql are not unfetched LFS pointers", run: checkLfsPointers },
  "public-env": { description: "EXPO_PUBLIC_* names are never secrets", run: checkPublicEnv },
  "shell-syntax": { description: "bash -n on every *.sh under tools/ and .github/", run: checkShellSyntax },
};

// ── CLI ────────────────────────────────────────────────────────────────

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
};

const STATUS_STYLE = {
  pass: { label: "PASS", color: ANSI.green },
  fail: { label: "FAIL", color: ANSI.red },
  warn: { label: "WARN", color: ANSI.yellow },
  skip: { label: "SKIP", color: ANSI.gray },
};

function colorize(text, useColor, ...styles) {
  if (!useColor || styles.length === 0) return text;
  return `${styles.join("")}${text}${ANSI.reset}`;
}

function printHuman(results, useColor) {
  for (const { name, status, details } of results) {
    const style = STATUS_STYLE[status];
    const line = `${colorize(style.label.padEnd(5), useColor, ANSI.bold, style.color)} ${name.padEnd(18)} ${details[0] ?? ""}`;
    console.log(line);
    for (const detail of details.slice(1)) {
      console.log(`         ${detail}`);
    }
  }
  console.log();
  const failed = results.filter((r) => r.status === "fail");
  const warned = results.filter((r) => r.status === "warn");
  const skipped = results.filter((r) => r.status === "skip");
  if (failed.length > 0) {
    console.log(colorize(`${failed.length} check(s) failed.`, useColor, ANSI.bold, ANSI.red));
  } else {
    console.log(colorize(`All ${results.length - skipped.length} run check(s) passed${warned.length > 0 ? ` (${warned.length} warning(s))` : ""}, ${skipped.length} skipped.`, useColor, ANSI.bold, ANSI.green));
  }
}

export function runChecks(names, root) {
  const ctx = createContext(root);
  return names.map((name) => {
    let result;
    try {
      result = CHECKS[name].run(ctx);
    } catch (error) {
      result = { status: "fail", details: [`check itself threw: ${error?.stack || error}`] };
    }
    return { name, status: result.status, details: result.details ?? [] };
  });
}

function parseArgs(argv) {
  const args = { only: null, list: false, json: false, root: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--list") args.list = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--only") args.only = argv[++i];
    else if (arg === "--root") args.root = argv[++i];
    else if (arg.startsWith("--only=")) args.only = arg.slice("--only=".length);
    else if (arg.startsWith("--root=")) args.root = arg.slice("--root=".length);
    else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);

  if (args.list) {
    for (const [name, { description }] of Object.entries(CHECKS)) {
      console.log(`${name.padEnd(18)} ${description}`);
    }
    return 0;
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const defaultRoot = path.resolve(scriptDir, "../..");
  const root = args.root ? path.resolve(process.cwd(), args.root) : defaultRoot;

  const names = args.only ? args.only.split(",").map((s) => s.trim()).filter(Boolean) : Object.keys(CHECKS);
  const unknown = names.filter((n) => !CHECKS[n]);
  if (unknown.length > 0) {
    console.error(`unknown check(s): ${unknown.join(", ")}`);
    console.error(`available: ${Object.keys(CHECKS).join(", ")}`);
    return 2;
  }

  const results = runChecks(names, root);

  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
    printHuman(results, useColor);
  }

  return results.some((r) => r.status === "fail") ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}

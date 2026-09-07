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

// Two accepted filename forms, both `<digits>_slug.sql`:
//
//   0001_init.sql              legacy, four-digit sequential (0001..0008 on main)
//   20260907143012_slug.sql    current, a UTC timestamp: YYYYMMDDHHMMSS
//
// Why two. D1 records applied migrations in `d1_migrations` **by filename**,
// so a rename de-registers an already-applied migration and the next deploy
// re-runs it (issue #99: a renumbered `0007_notify_failed.sql` -> `0008_...`
// re-ran `ALTER TABLE ... ADD COLUMN` and died on `duplicate column name`,
// breaking `deploy (preview)` for every concurrent pull request, because
// preview is one shared database — #66/#73). Renaming the legacy files to fit
// the new convention would *be* that bug, so they stay exactly as they are and
// only new migrations get timestamps.
//
// Why timestamps for new ones. A sequential number has to be claimed when the
// file is written, and two branches cut from the same `main` claim the same
// one. Whoever merges second must renumber on rebase — and by then the shared
// preview D1 has already applied the file under the old name. A timestamp is
// claimed from the clock, not from the state of `main`, so two concurrent
// branches cannot collide and a rebase never forces a rename.
const LEGACY_MIGRATION_NAME_RE = /^(\d{4})_[A-Za-z0-9_]+\.sql$/;
const TIMESTAMP_MIGRATION_NAME_RE = /^(\d{14})_[A-Za-z0-9_]+\.sql$/;

// `wrangler d1 migrations apply` orders files by `parseInt(basename.split("_")[0])`
// ascending, falling back to a plain string compare when two prefixes parse to
// the same number (wrangler-dist/cli.js `compareSegments`/`leadingMigrationNumber`);
// `@cloudflare/vitest-pool-workers`'s `readD1Migrations`, which the apps/api
// suite applies against a fresh D1 on every run, sorts by the identical
// expression. Mirrored here so preflight asserts the order that actually runs
// rather than a lexicographic guess.
export function migrationApplyOrder(basenames) {
  const leading = (name) => Number.parseInt(name.split("_")[0], 10);
  return [...basenames].sort((a, b) => {
    const an = leading(a);
    const bn = leading(b);
    if (an !== bn) {
      if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
      if (Number.isFinite(an)) return -1;
      if (Number.isFinite(bn)) return 1;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

// A 14-digit prefix has to be a real UTC instant, not just fourteen digits: a
// typo'd month or hour still sorts fine but stops the name meaning what a
// reader thinks it means. Year >= 2000 is the load-bearing part — it is what
// guarantees every timestamped migration sorts after every legacy 000N one.
function timestampPrefixProblem(prefix) {
  const year = Number(prefix.slice(0, 4));
  const month = Number(prefix.slice(4, 6));
  const day = Number(prefix.slice(6, 8));
  const hour = Number(prefix.slice(8, 10));
  const minute = Number(prefix.slice(10, 12));
  const second = Number(prefix.slice(12, 14));
  if (year < 2000 || year > 2999) return `year ${prefix.slice(0, 4)} is not 2000-2999`;
  if (month < 1 || month > 12) return `month ${prefix.slice(4, 6)} is not 01-12`;
  if (day < 1 || day > 31) return `day ${prefix.slice(6, 8)} is not 01-31`;
  if (hour > 23) return `hour ${prefix.slice(8, 10)} is not 00-23`;
  if (minute > 59) return `minute ${prefix.slice(10, 12)} is not 00-59`;
  if (second > 59) return `second ${prefix.slice(12, 14)} is not 00-59`;
  return null;
}

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

// Top-level *.sql in the migrations directory, which is exactly what wrangler
// picks up (`migrations_pattern` defaults to `<migrations_dir>/*.sql`).
function migrationFiles(ctx) {
  return ctx.walk(MIGRATIONS_DIR)
    .filter((f) => path.posix.dirname(f) === MIGRATIONS_DIR && f.endsWith(".sql"))
    .sort();
}

function checkMigrations(ctx) {
  if (!ctx.exists(MIGRATIONS_DIR)) return { status: "skip", details: [`${MIGRATIONS_DIR} not present`] };
  const files = migrationFiles(ctx);

  if (files.length === 0) return { status: "skip", details: [`${MIGRATIONS_DIR} has no *.sql files yet`] };

  const details = [];
  const prefixToFiles = new Map();
  const legacyNumbers = [];
  let timestamped = 0;
  for (const file of files) {
    const base = path.posix.basename(file);
    const legacy = base.match(LEGACY_MIGRATION_NAME_RE);
    const stamped = base.match(TIMESTAMP_MIGRATION_NAME_RE);
    if (!legacy && !stamped) {
      details.push(
        `${file}: name must be YYYYMMDDHHMMSS_slug.sql (UTC, e.g. \`date -u +%Y%m%d%H%M%S\`) — or the legacy NNNN_slug.sql form, which is frozen at the migrations already on main`,
      );
      continue;
    }
    const prefix = (legacy ?? stamped)[1];
    if (stamped) {
      timestamped += 1;
      const problem = timestampPrefixProblem(prefix);
      if (problem) details.push(`${file}: ${problem} — the prefix must be a real UTC timestamp`);
    } else {
      legacyNumbers.push(Number.parseInt(prefix, 10));
    }
    if (!prefixToFiles.has(prefix)) prefixToFiles.set(prefix, []);
    prefixToFiles.get(prefix).push(file);

    const text = ctx.readText(file) ?? "";
    if (!stripTrailingSqlComments(text).endsWith(";")) {
      details.push(`${file}: does not end with ';' (ignoring trailing whitespace/comments)`);
    }
  }

  for (const [prefix, group] of prefixToFiles) {
    if (group.length > 1) {
      details.push(
        `duplicate migration prefix ${prefix}: ${group.join(", ")} — renaming one of these to break the tie de-registers it in d1_migrations if a deploy already applied it (#99); pick a fresh timestamp for whichever has not been deployed`,
      );
    }
  }

  // The legacy block is still required to be 0001-contiguous: a gap there
  // means a file was deleted, which is the drift `migration-drift` exists to
  // catch and is worth reporting even without git.
  // Deduplicated so a duplicate prefix reports once, as a duplicate, instead
  // of also dragging a confusing "gap" line along behind it.
  const distinctLegacy = [...new Set(legacyNumbers)].sort((a, b) => a - b);
  for (let i = 0; i < distinctLegacy.length; i += 1) {
    const expected = i + 1;
    if (distinctLegacy[i] !== expected) {
      details.push(
        `legacy migration numbering has a gap or does not start at 0001: expected ${String(expected).padStart(4, "0")}, found ${String(distinctLegacy[i]).padStart(4, "0")}`,
      );
      break;
    }
  }

  // The invariant wrangler's ordering rests on: every timestamped migration
  // must run after every legacy one. Guaranteed by the year >= 2000 rule
  // above, asserted here so a future loosening of that rule fails loudly.
  const order = migrationApplyOrder(files.map((f) => path.posix.basename(f)));
  const lastLegacyAt = order.reduce((acc, name, i) => (LEGACY_MIGRATION_NAME_RE.test(name) ? i : acc), -1);
  const firstStampedAt = order.findIndex((name) => TIMESTAMP_MIGRATION_NAME_RE.test(name));
  if (firstStampedAt !== -1 && lastLegacyAt > firstStampedAt) {
    details.push(
      `apply order interleaves the two naming schemes (${order[firstStampedAt]} would run before ${order[lastLegacyAt]}); every timestamped migration must sort after every legacy one`,
    );
  }

  if (details.length > 0) return { status: "fail", details };
  return {
    status: "pass",
    details: [
      `${files.length} migration(s) (${distinctLegacy.length} legacy 0001-contiguous, ${timestamped} timestamped), apply order ${order[0]} … ${order[order.length - 1]}`,
    ],
  };
}

// ── migration-drift: D1's ledger is keyed on the filename ────────────────
//
// `d1_migrations` stores the filename, not a content hash or a stable id. So
// once a deploy has applied `0007_notify_failed.sql`, that exact string is the
// only thing that stops it running again — rename the file and the next deploy
// re-runs its SQL against a schema that already has the change. Preview
// deploys on **every** open pull request into one shared database (#66), so
// the blast radius is every concurrent branch, not just yours.
//
// This is the one guard that needs history rather than the working tree, so it
// shells out to git. Three rules:
//
//   1. Nothing that has landed on `main` may be modified, renamed or deleted.
//   2. Nothing this branch has already committed (and therefore may already
//      have deployed to preview) may vanish.
//   3. A migration this branch *adds* must use the timestamp form, because the
//      sequential form is what forces the rename in rule 2 after a rebase.
//
// It cannot run without a baseline to compare against. Rather than pass
// silently — the failure mode AGENTS.md catalogues five times over — it
// reports SKIP with the reason, and turns that SKIP into a FAIL wherever a
// baseline is guaranteed to be fetchable (GitHub Actions, or an explicit
// PREFLIGHT_REQUIRE_GIT_BASELINE=1).
const BASELINE_REF = "origin/main";

function gitRun(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function baselineRequired(env = process.env) {
  return env.GITHUB_ACTIONS === "true" || env.PREFLIGHT_REQUIRE_GIT_BASELINE === "1";
}

function cannotRun(reason) {
  const required = baselineRequired();
  const line = `${reason} — this check did NOT run`;
  return {
    status: required ? "fail" : "skip",
    details: required
      ? [`${line}, and a baseline is required here (GITHUB_ACTIONS/PREFLIGHT_REQUIRE_GIT_BASELINE)`]
      : [line, `set PREFLIGHT_REQUIRE_GIT_BASELINE=1 to make this a failure instead of a skip`],
  };
}

function isMigrationPath(p) {
  return p.startsWith(`${MIGRATIONS_DIR}/`) && p.endsWith(".sql") && path.posix.dirname(p) === MIGRATIONS_DIR;
}

function checkMigrationDrift(ctx) {
  if (!ctx.exists(MIGRATIONS_DIR)) return { status: "skip", details: [`${MIGRATIONS_DIR} not present`] };

  if (!gitRun(ctx.root, ["rev-parse", "--git-dir"]).ok) {
    return cannotRun(`${ctx.root} is not a git work tree (or git is not installed)`);
  }
  if (!gitRun(ctx.root, ["rev-parse", "--verify", "--quiet", `${BASELINE_REF}^{commit}`]).ok) {
    return cannotRun(`no ${BASELINE_REF} ref — run: git fetch origin main`);
  }
  const mergeBase = gitRun(ctx.root, ["merge-base", BASELINE_REF, "HEAD"]);
  if (!mergeBase.ok || mergeBase.stdout === "") {
    return cannotRun(
      `${BASELINE_REF} and HEAD share no merge base (a shallow clone will do this — fetch with depth 0)`,
    );
  }
  const base = mergeBase.stdout;

  const details = [];
  const reported = new Set();

  // Rule 1 — landed migrations are frozen. `git diff <commit> -- <path>`
  // compares the commit against the *working tree*, so an edit that has not
  // even been staged is caught.
  const landed = gitRun(ctx.root, [
    "diff", "--name-status", "-M", "--diff-filter=DMR", base, "--", MIGRATIONS_DIR,
  ]);
  if (!landed.ok) return cannotRun(`git diff against ${base.slice(0, 8)} failed: ${landed.stderr || "unknown error"}`);
  for (const line of landed.stdout.split("\n").filter(Boolean)) {
    const [status, from, to] = line.split("\t");
    if (!isMigrationPath(from)) continue;
    reported.add(from);
    const applied = `d1_migrations already records "${path.posix.basename(from)}" as applied on preview and production`;
    if (status.startsWith("R")) {
      details.push(`${from} -> ${to}: renamed after landing on ${BASELINE_REF} — ${applied}, so the new name re-runs the SQL. Restore the name and add a new migration instead.`);
    } else if (status.startsWith("D")) {
      details.push(`${from}: deleted after landing on ${BASELINE_REF} — ${applied}; deleting it does not undo it. Restore the file and add a new migration that reverses the change.`);
    } else {
      details.push(`${from}: edited after landing on ${BASELINE_REF} — ${applied}, so this edit will never run anywhere it has already been applied. Revert it and add a new migration.`);
    }
  }

  // Rule 2 — anything this branch committed may already be on shared preview,
  // which redeploys on every push to an open pull request. `--no-renames` so a
  // rename shows up as its old path being touched, which is what we want to
  // notice. Bounded so a long-lived branch cannot make preflight slow.
  const branchLog = gitRun(ctx.root, [
    "log", "--max-count=500", "--pretty=format:", "--name-only", "--no-renames", `${base}..HEAD`, "--", MIGRATIONS_DIR,
  ]);
  if (branchLog.ok) {
    for (const p of new Set(branchLog.stdout.split("\n").map((s) => s.trim()).filter(Boolean))) {
      if (!isMigrationPath(p) || reported.has(p) || ctx.exists(p)) continue;
      reported.add(p);
      details.push(
        `${p}: committed on this branch and then removed or renamed — every push to an open pull request deploys to the one shared preview D1 (#66), which has already recorded "${path.posix.basename(p)}" as applied. Keep the name. If the commit that added it was never pushed, amend or squash it away rather than renaming the file.`,
      );
    }
  }

  // Rule 3 — new migrations must be timestamped. A sequential number is
  // claimed from the state of `main` at the moment the file is written, so two
  // branches cut from the same `main` claim the same one, and the second to
  // merge has to renumber — which is rule 2's failure, arrived at honestly.
  const addedTracked = gitRun(ctx.root, ["diff", "--name-only", "--diff-filter=A", base, "--", MIGRATIONS_DIR]);
  const addedUntracked = gitRun(ctx.root, ["ls-files", "--others", "--exclude-standard", "--", MIGRATIONS_DIR]);
  const added = new Set(
    [addedTracked, addedUntracked]
      .filter((r) => r.ok)
      .flatMap((r) => r.stdout.split("\n").map((s) => s.trim()))
      .filter((p) => p && isMigrationPath(p) && ctx.exists(p)),
  );
  for (const p of [...added].sort()) {
    if (TIMESTAMP_MIGRATION_NAME_RE.test(path.posix.basename(p))) continue;
    details.push(
      `${p}: new migrations must be named YYYYMMDDHHMMSS_slug.sql (UTC — \`date -u +%Y%m%d%H%M%S\`). A sequential prefix is a shared namespace: another branch cut from the same ${BASELINE_REF} can claim it too, and the one that merges second must rename on rebase, which de-registers it in d1_migrations (#99).`,
    );
  }

  if (details.length > 0) return { status: "fail", details };
  const trackedCount = migrationFiles(ctx).length;
  return {
    status: "pass",
    details: [
      `${trackedCount} migration(s) checked against ${BASELINE_REF} (merge-base ${base.slice(0, 8)}): none renamed, edited or deleted; ${added.size} added, all timestamped`,
    ],
  };
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
  migrations: { description: "apps/api/migrations/*.sql naming, apply order and terminators", run: checkMigrations },
  "migration-drift": { description: "no landed migration is renamed/edited/deleted (git)", run: checkMigrationDrift },
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

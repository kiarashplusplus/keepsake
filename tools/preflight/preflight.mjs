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

// ── cron-triggers ─────────────────────────────────────────────────────────
//
// Two scheduled jobs carry real work: `moderationRetry` (every 5 minutes,
// un-strands a listing whose moderation call died mid-`waitUntil`) and
// `orphanSweep` (nightly, deletes never-attached photos and sweeps terminal
// listings' R2 bytes). Both are invisible when they stop: nothing user-facing
// changes the day a cron detaches, listings just quietly stay `pending` and
// photos quietly accumulate. That is precisely the shape of guard this repo
// keeps finding dead, so it gets a check.
//
// **Is `[triggers]` inherited into a named environment?** Yes — established,
// not assumed. Every other block in `wrangler.toml` is restated per
// environment because Wrangler genuinely does not inherit `[vars]` or any
// `[[binding]]`, and `[triggers]` is declared only at the top level, which
// looked like the same bug. It is not:
//
//   - `wrangler`'s own config normalizer registers `triggers` through its
//     `inheritable(...)` helper — the same one `main`, `compatibility_date`
//     and `routes` use — above the file's literal `// Not inherited fields`
//     comment, under which `vars`, `secrets` and the bindings sit
//     (`node_modules/wrangler/wrangler-dist/cli.js`, wrangler 4.129.0).
//   - Confirmed by resolving the real file through wrangler's own API rather
//     than by reading source: `unstable_readConfig({ config: "wrangler.toml",
//     env })` returns `{"crons":["*/5 * * * *","17 3 * * *"]}` for `undefined`,
//     `"preview"` and `"production"` alike.
//
// So the absence of `[env.*.triggers]` is correct, and this check exists to
// keep it true rather than to fix a bug: it asserts every deployed tier still
// resolves a non-empty, syntactically valid cron list, and — the half that
// catches the more likely mistake — that every declared schedule matches a
// `case` in `scheduled()` and vice versa. `scheduled()` dispatches on the
// literal cron string (`apps/api/src/index.ts`), so editing a schedule in
// `wrangler.toml` without editing the switch leaves the job registered with
// Cloudflare, firing on time, and falling straight through to `default:` — a
// `console.warn` and no work done, on a handler that reports success.
const API_INDEX_PATH = "apps/api/src/index.ts";

/** Drop a `#` comment, but only one that starts outside a quoted string. */
function stripTomlComment(line) {
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === "#" && !inQuote) return line.slice(0, i);
  }
  return line;
}

/**
 * Every `crons = [...]` in the file, keyed by the section that holds it
 * (`triggers`, `env.preview.triggers`, …). Values may span lines.
 *
 * A section present with an empty list is kept as `[]` and is *not* the same
 * as an absent section: `[env.production.triggers]\ncrons = []` is an
 * override that switches the tier's crons off, which inheritance would
 * otherwise have supplied — exactly the difference this check has to see.
 */
export function parseCronTriggers(text) {
  const sections = {};
  const quoted = (chunk) => [...chunk.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  let current = null;
  let pending = null;
  for (const rawLine of text.split("\n")) {
    const line = stripTomlComment(rawLine).trim();
    if (pending) {
      pending.chunk += ` ${line}`;
      if (line.includes("]")) {
        sections[pending.section] = quoted(pending.chunk);
        pending = null;
      }
      continue;
    }
    if (!line) continue;
    if (/^\[\[[^\]]+\]\]$/.test(line)) {
      current = null;
      continue;
    }
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      current = header[1].trim();
      continue;
    }
    if (!current || !/(^|\.)triggers$/.test(current)) continue;
    const kv = line.match(/^crons\s*=\s*(.*)$/);
    if (!kv) continue;
    if (kv[1].includes("]")) sections[current] = quoted(kv[1]);
    else pending = { section: current, chunk: kv[1] };
  }
  return sections;
}

const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

// `max` is the inclusive ceiling of the plain-numeric form. Day-of-week goes
// to 7 because both 0 and 7 mean Sunday in standard cron.
const CRON_FIELDS = [
  { label: "minute", min: 0, max: 59 },
  { label: "hour", min: 0, max: 23 },
  { label: "day-of-month", min: 1, max: 31, special: /^(\?|L|LW|\d{1,2}W)$/ },
  { label: "month", min: 1, max: 12, names: MONTH_NAMES, offset: 1 },
  { label: "day-of-week", min: 0, max: 7, names: DAY_NAMES, offset: 0, special: /^(\?|L|\d#\d|\dL)$/ },
];

function cronEndpointValue(token, spec) {
  if (spec.names) {
    const index = spec.names.indexOf(token.toUpperCase());
    if (index !== -1) return index + spec.offset;
  }
  if (!/^\d{1,2}$/.test(token)) return null;
  return Number(token);
}

function cronFieldProblem(field, spec) {
  if (field === "") return `${spec.label} is empty`;
  if (spec.special?.test(field)) return null;
  for (const part of field.split(",")) {
    if (part === "") return `${spec.label} "${field}" has an empty list entry`;
    const [rangePart, stepPart, ...rest] = part.split("/");
    if (rest.length > 0) return `${spec.label} "${part}" has more than one "/"`;
    if (stepPart !== undefined) {
      if (!/^\d{1,2}$/.test(stepPart) || Number(stepPart) < 1) {
        return `${spec.label} "${part}" has step "${stepPart}", which must be an integer >= 1`;
      }
    }
    if (rangePart === "*") continue;
    const endpoints = rangePart.split("-");
    if (endpoints.length > 2) return `${spec.label} "${part}" has more than one "-"`;
    const values = [];
    for (const endpoint of endpoints) {
      const value = cronEndpointValue(endpoint, spec);
      if (value === null) return `${spec.label} "${endpoint}" is not a number${spec.names ? " or name" : ""}`;
      if (value < spec.min || value > spec.max) {
        return `${spec.label} "${endpoint}" is outside ${spec.min}-${spec.max}`;
      }
      values.push(value);
    }
    if (values.length === 2 && values[0] > values[1]) {
      return `${spec.label} "${part}" is a reversed range`;
    }
  }
  return null;
}

/** `null` if `expr` is a schedule Cloudflare would accept, else why not. */
export function cronExpressionProblem(expr) {
  const fields = expr.trim().split(/\s+/).filter(Boolean);
  if (expr.trim() === "") return "is empty";
  if (fields.length !== 5) {
    return `has ${fields.length} field(s), not 5 (minute hour day-of-month month day-of-week)`;
  }
  for (let i = 0; i < CRON_FIELDS.length; i += 1) {
    const problem = cronFieldProblem(fields[i], CRON_FIELDS[i]);
    if (problem) return problem;
  }
  return null;
}

/**
 * The cron strings `scheduled()` actually dispatches on, read out of its
 * `switch (controller.cron)`. Bounded to that function's body so an unrelated
 * `case "..."` elsewhere in the file is not mistaken for a cron.
 */
export function scheduledCronCases(text) {
  const start = text.search(/function\s+scheduled\s*\(/);
  if (start === -1) return null;
  const rest = text.slice(start);
  const end = rest.search(/\n\}/);
  const body = end === -1 ? rest : rest.slice(0, end);
  return [...body.matchAll(/case\s+"([^"]*)"/g)].map((m) => m[1]);
}

function checkCronTriggers(ctx) {
  const wranglerText = ctx.readText(WRANGLER_PATH);
  if (wranglerText === null) return { status: "skip", details: [`${WRANGLER_PATH} not present`] };

  const triggerSections = parseCronTriggers(wranglerText);
  const indexText = ctx.readText(API_INDEX_PATH);
  const handled = indexText === null ? null : scheduledCronCases(indexText);
  const declared = Object.keys(triggerSections).length > 0;

  if (!declared) {
    if (handled && handled.length > 0) {
      return {
        status: "fail",
        details: [
          `${API_INDEX_PATH}: scheduled() handles ${handled.map((c) => `"${c}"`).join(", ")} but ${WRANGLER_PATH} declares no [triggers] crons — nothing will ever invoke it`,
        ],
      };
    }
    return { status: "skip", details: [`${WRANGLER_PATH} declares no [triggers] crons`] };
  }

  const details = [];
  const topLevel = triggerSections.triggers;
  const envNames = Object.keys(parseToml(wranglerText))
    .map((s) => s.match(/^env\.([^.]+)\.vars$/))
    .filter(Boolean)
    .map((m) => m[1]);

  // Each deployed tier must end up with crons, whether by inheriting the
  // top-level list (verified above) or by restating its own.
  const tiers = [{ label: "[triggers] (top level)", crons: topLevel, own: topLevel !== undefined }];
  for (const envName of envNames) {
    const own = triggerSections[`env.${envName}.triggers`];
    tiers.push({
      label: `env.${envName}`,
      crons: own ?? topLevel,
      own: own !== undefined,
      envName,
    });
  }

  const resolved = new Set();
  for (const tier of tiers) {
    if (tier.crons === undefined) {
      details.push(
        `${tier.label}: no crons resolve — neither a top-level [triggers] nor [env.${tier.envName}.triggers] declares any, so this tier deploys with no scheduled jobs`,
      );
      continue;
    }
    if (tier.crons.length === 0) {
      details.push(
        tier.own
          ? `${tier.label}: crons = [] — an empty list in an env block overrides the inherited [triggers], so ${tier.envName ?? "this tier"} deploys with no scheduled jobs at all`
          : `${tier.label}: crons = [] — no scheduled jobs are registered anywhere`,
      );
      continue;
    }
    for (const cron of tier.crons) resolved.add(cron);
  }

  for (const cron of [...resolved].sort()) {
    const problem = cronExpressionProblem(cron);
    if (problem) details.push(`crons entry "${cron}": ${problem}`);
  }

  // The half that catches the likelier mistake: `scheduled()` switches on the
  // literal cron string, so a schedule edited in one place and not the other
  // keeps firing and does nothing.
  if (indexText === null) {
    details.push(`${API_INDEX_PATH} not present, so nothing was checked against the declared crons`);
  } else if (handled === null) {
    details.push(
      `${API_INDEX_PATH}: no scheduled() handler, but ${WRANGLER_PATH} declares ${resolved.size} cron(s) — Cloudflare would invoke a handler that does not exist`,
    );
  } else {
    for (const cron of [...resolved].sort()) {
      if (!handled.includes(cron)) {
        details.push(
          `cron "${cron}" is declared in ${WRANGLER_PATH} but no case in ${API_INDEX_PATH}'s scheduled() matches it — it would fire on schedule and fall through to default:, warning and doing nothing`,
        );
      }
    }
    for (const cron of handled) {
      if (!resolved.has(cron)) {
        details.push(
          `${API_INDEX_PATH}: scheduled() handles "${cron}", which ${WRANGLER_PATH} does not declare — that job never runs`,
        );
      }
    }
  }

  if (details.length > 0) return { status: "fail", details };
  const inherited = tiers.filter((t) => t.envName && !t.own).map((t) => t.envName);
  return {
    status: "pass",
    details: [
      `${resolved.size} cron(s) valid and handled by scheduled(): ${[...resolved].sort().map((c) => `"${c}"`).join(", ")}` +
        (inherited.length > 0 ? `; inherited by ${inherited.join(", ")}` : ""),
    ],
  };
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

// ── ip-digest ─────────────────────────────────────────────────────────
//
// Issue #87: two shapes of "hash the caller's IP" lived in this Worker at
// once. `src/moderation/budget.ts` salted with the UTC day; `burst()` in
// `src/middleware/rateLimit.ts` and `idempotency()` hashed the bare address,
// producing a stable pseudonymous identifier for one caller that never
// rotated. `apps/site/public/privacy.html`'s "Rate limiting" section
// describes only the first shape — "combined with the date", worked example
// `sha256("2026-09-05:203.0.113.4")` — so the second made a published policy
// claim false, which is exactly the drift launch-audit §7 named.
//
// The fix is one helper (`dailyIpDigest` in `src/lib/digest.ts`) and this
// check, so a new hashing site can't reintroduce the other shape. Three
// rules:
//
//   1. `crypto.subtle.digest(` only in `src/lib/digest.ts` — a hand-rolled
//      digest elsewhere would sidestep rules 2 and 3 entirely.
//   2. No hashing primitive called on an expression that mentions a client
//      IP outside that file: `sha256Hex(clientIPFrom(...))`,
//      `sha256Hex(`${todayISO()}:${clientIP}`)`, `sha256Hex(ip)` and friends
//      all fail. Use `dailyIpDigest`.
//   3. `dailyIpDigest` itself must actually include the day.
//
// Known gap, stated rather than papered over: rule 2 reads one call
// expression at a time, so assigning a digest of an address across two
// statements with a variable name containing no "ip" would slip past it.
// `apps/api/test/ipDigest.test.ts` covers the other side — it asserts the key
// `burst()` actually hands the binding is the day-salted digest and not a
// bare hash of the address — so a dodge would have to defeat both.
const DIGEST_PATH = "apps/api/src/lib/digest.ts";
const DAILY_DIGEST_FN = "dailyIpDigest";
const HASH_PRIMITIVES = String.raw`(?:sha256Hex|crypto\.subtle\.digest)`;
// A hashing call whose argument expression mentions a client IP, on one line.
const HASHED_IP_RE = new RegExp(`${HASH_PRIMITIVES}\\s*\\([^;]{0,200}?client_?[iI][pP]`);
// `sha256Hex(ip)` / `sha256Hex(clientIp)` — a bare identifier that reads as
// an address, which rule 2's first regex misses when the name is the only
// thing naming it.
const HASHED_IP_IDENT_RE = new RegExp(`${HASH_PRIMITIVES}\\s*\\(\\s*[A-Za-z_$]*[iI][pP][A-Za-z0-9_$]*\\s*\\)`);
const RAW_DIGEST_RE = /crypto\.subtle\.digest\s*\(/;

function checkIpDigest(ctx) {
  if (!ctx.exists(API_SRC_DIR)) return { status: "skip", details: [`${API_SRC_DIR} not present`] };
  const files = ctx.walk(API_SRC_DIR).filter((f) => /\.(ts|tsx|js|mjs)$/.test(f));
  if (files.length === 0) return { status: "skip", details: [`${API_SRC_DIR} has no source files yet`] };

  const details = [];
  let scanned = 0;
  for (const file of files) {
    if (isTestFile(file)) continue;
    const text = ctx.readText(file) ?? "";
    if (file === DIGEST_PATH) continue;
    scanned += 1;
    text.split("\n").forEach((line, i) => {
      const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "");
      if (RAW_DIGEST_RE.test(code)) {
        details.push(`${file}:${i + 1}: crypto.subtle.digest() outside ${DIGEST_PATH} — hash through that module instead`);
      }
      if (HASHED_IP_RE.test(code) || HASHED_IP_IDENT_RE.test(code)) {
        details.push(
          `${file}:${i + 1}: hashes a client IP without the day — use ${DAILY_DIGEST_FN}() from ${DIGEST_PATH}, ` +
            `which is the only shape apps/site/public/privacy.html describes`,
        );
      }
    });
  }

  const digestText = ctx.readText(DIGEST_PATH);
  if (digestText === null) {
    details.push(`${DIGEST_PATH} is missing — it holds the one day-rotating IP digest`);
  } else {
    const fn = new RegExp(`export\\s+async\\s+function\\s+${DAILY_DIGEST_FN}\\s*\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(digestText);
    if (!fn) {
      details.push(`${DIGEST_PATH}: no exported ${DAILY_DIGEST_FN}() — every IP digest is meant to go through it`);
    } else if (!/todayISO\s*\(\)/.test(fn[1])) {
      details.push(`${DIGEST_PATH}: ${DAILY_DIGEST_FN}() does not include todayISO() — the digest would never rotate`);
    }
  }

  if (details.length > 0) return { status: "fail", details };
  return { status: "pass", details: [`${scanned} file(s) scanned under ${API_SRC_DIR}; IP digests all rotate daily via ${DAILY_DIGEST_FN}()`] };
}

// ── var-usage ─────────────────────────────────────────────────────────────
//
// Issue #128. `env-parity` above compares four copies of one list —
// `.env.example` and the three `[vars]` blocks — and they can agree perfectly
// while agreeing with nothing the Worker actually does. Two failures live in
// that blind spot, and this repo has met both:
//
//   - **Read by the code, declared nowhere.** #92 added per-IP daily ceilings
//     to the report path and the two mail-sending routes, read through a code
//     fallback. Had the `[vars]` lines been forgotten, nothing would have
//     looked wrong — the fallback is the same number — but the two ceilings
//     most likely to be wanted *during* an incident (a report flood is a
//     takedown vector at three reports; a mail runaway spends deliverability
//     reputation on a `p=reject` domain) could not have been turned down
//     without a code deploy. They were in fact declared; #128 was filed
//     against a checkout from 45 minutes before that merge. Nothing here
//     could have answered that question, which is the actual defect.
//   - **Declared everywhere, read by nobody.** `MAX_PHOTOS` and
//     `IMAGE_TRANSFORMS_ENABLED` sat in all three blocks referencing nothing
//     until the 2026-09-06 launch audit removed them by eye. A knob that
//     cannot change behavior is worse than no knob: someone reaches for it
//     mid-incident and it does nothing, and reports the incident handled.
//
// A third rule keeps the first two honest. `parseIntVar` degrading to a code
// fallback is correct — a malformed budget should not 500 the Worker — but it
// also means a fallback that disagrees with `[vars]` makes the declared number
// a lie about what runs when the var is missing or mistyped. So every fallback
// this check can resolve must equal the top-level `[vars]` value.
//
// **Resolving the names is the whole difficulty**, because not every read is a
// member access. `dailyBudget()` reads `c.env[options.ipDailyLimitVar]`, so
// none of the five `*_IP_DAILY_BUDGET` names appears as `env.X` anywhere:
// grepping for `env.REPORT_IP_DAILY_BUDGET` finds nothing whether or not it is
// declared, which is how #128 came to be filed against a var already sitting
// in all three blocks. Four sources, each an existing convention in the code:
//
//   1. `env.NAME` / `c.env.NAME` — the direct member read.
//   2. `parseIntVar("NAME", …)` — the name is that helper's first argument,
//      passed precisely so a failed parse can say which var it was.
//   3. Members of a `type …Var = "A" | "B"` string-literal union
//      (`IpDailyLimitVar` in `src/middleware/rateLimit.ts`).
//   4. `…Var: "NAME"` properties at the call sites that feed those unions.
//
// The gap that leaves is a computed `env[expr]` whose key this check cannot
// read — and an unreadable key would make it *under*-report, i.e. fail silent,
// which is the failure mode this repo keeps finding. So that gap is itself a
// failure: a computed access must name what it is reaching for, either a var
// (`…Var`, whose literals rules 3 and 4 collect) or a binding (`…binding…`,
// exempt — bindings are `[[…]]` tables, not `[vars]`, and `assertBindings`
// plus `wrangler types` cover those). Anything else fails and asks to be
// named. Secrets are excluded from rule 1 by `.env.example`'s `# secrets:`
// block: they are read exactly like a var but set with `wrangler secret put`,
// and `env-parity` already fails if one appears in `[vars]`.
const VAR_TOKEN = String.raw`[A-Z][A-Z0-9_]{2,}`;
// `(?<!process\.)` so a Node-side `process.env.CI` could never read as a
// Worker var; nothing under apps/api/src does that today.
const ENV_MEMBER_RE = new RegExp(String.raw`(?<!process\.)\benv\.(${VAR_TOKEN})\b`, "g");
const PARSE_INT_VAR_NAME_RE = new RegExp(String.raw`parseIntVar\(\s*"(${VAR_TOKEN})"`, "g");
const VAR_UNION_RE = /type\s+[A-Za-z_$][\w$]*Var\s*=([^;]*);/g;
const VAR_PROPERTY_RE = new RegExp(String.raw`[A-Za-z_$][\w$]*Var\s*:\s*"(${VAR_TOKEN})"`, "g");
const COMPUTED_ENV_RE = /(?<!process\.)\benv\[([^\]]*)\]/g;
const QUOTED_VAR_RE = new RegExp(String.raw`"(${VAR_TOKEN})"`, "g");
const CONST_DECL_RE = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+)?=\s*([^;\n]+)/g;
// `binding = "KV"` / `name = "RL_READ"` — the `[[…]]` tables `parseToml`
// deliberately drops, collected straight off the text so bindings are never
// mistaken for undeclared vars.
const TOML_BINDING_RE = /^\s*(?:binding|name)\s*=\s*"([A-Z][A-Z0-9_]*)"/gm;

/** Strip whole-line comments the same way `checkModels`/`checkIpDigest` do.
 * Prose in this repo names vars constantly (`env.MOCK_AI === "1"` appears in
 * three doc comments), and counting a comment as a read would let a var that
 * nothing calls pass rule 2. */
function stripCommentLines(text) {
  return text
    .split("\n")
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? "" : line.replace(/\/\/.*$/, "")))
    .join("\n");
}

/** Split the argument list of a call whose `(` is at `open`, on top-level
 * commas. Returns null if the parens never balance. Hand-rolled rather than
 * regexed because `parseIntVar(name, c.env.X as string | undefined, FALLBACK)`
 * is written across three lines in `src/env.ts`. */
export function callArguments(text, open) {
  let depth = 0;
  let start = open + 1;
  const args = [];
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) {
        args.push(text.slice(start, i).trim());
        return args;
      }
    } else if (ch === "," && depth === 1) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  return null;
}

/** Resolve a fallback expression to a number, or `undefined` when it is not
 * something this check can read (`options.fallbackIpDailyLimit` inside
 * `dailyBudget` itself, say — the call sites supply the real value and are
 * matched separately). Handles an integer literal, a product of integer
 * literals (`5 * 1024 * 1024`), and an identifier declared as either, looked
 * up in the file first and then across `apps/api/src` so an imported constant
 * like `DEFAULT_EMAIL_IP_DAILY_BUDGET` resolves. */
export function resolveNumericExpr(expr, localConsts, globalConsts, seen = new Set()) {
  const trimmed = (expr ?? "").trim().replace(/;$/, "");
  if (trimmed === "") return undefined;
  if (/^[\d_]+$/.test(trimmed)) return Number(trimmed.replace(/_/g, ""));
  if (/^[\d_\s*]+$/.test(trimmed) && trimmed.includes("*")) {
    const parts = trimmed.split("*").map((p) => Number(p.trim().replace(/_/g, "")));
    if (parts.every((n) => Number.isFinite(n))) return parts.reduce((a, b) => a * b, 1);
  }
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
    if (seen.has(trimmed)) return undefined;
    seen.add(trimmed);
    const next = localConsts?.get(trimmed) ?? globalConsts.get(trimmed);
    if (next === undefined) return undefined;
    return resolveNumericExpr(next, localConsts, globalConsts, seen);
  }
  return undefined;
}

function checkVarUsage(ctx) {
  const wranglerText = ctx.readText(WRANGLER_PATH);
  if (wranglerText === null) return { status: "skip", details: [`${WRANGLER_PATH} not present`] };
  if (!ctx.exists(API_SRC_DIR)) return { status: "skip", details: [`${API_SRC_DIR} not present`] };
  const files = ctx.walk(API_SRC_DIR).filter((f) => /\.(ts|tsx|js|mjs)$/.test(f) && !isTestFile(f));
  if (files.length === 0) return { status: "skip", details: [`${API_SRC_DIR} has no source files yet`] };

  const toml = parseToml(wranglerText);
  const declared = new Map(Object.entries(toml.vars ?? {}));
  if (declared.size === 0) return { status: "skip", details: [`${WRANGLER_PATH} has no top-level [vars]`] };

  const bindings = new Set([...wranglerText.matchAll(TOML_BINDING_RE)].map((m) => m[1]));
  const envExampleText = ctx.readText(ENV_EXAMPLE_PATH);
  const secrets = envExampleText === null ? new Set() : parseEnvExample(envExampleText).secretNames;

  const details = [];
  // name -> "file:line" of the first read, so a failure can point at one.
  const readAt = new Map();
  const noteRead = (name, where) => {
    if (!readAt.has(name)) readAt.set(name, where);
  };
  const lineOf = (text, index) => text.slice(0, index).split("\n").length;

  const globalConsts = new Map();
  const sources = new Map();
  for (const file of files) {
    const text = stripCommentLines(ctx.readText(file) ?? "");
    sources.set(file, text);
    for (const m of text.matchAll(CONST_DECL_RE)) {
      if (!globalConsts.has(m[1])) globalConsts.set(m[1], m[2]);
    }
  }

  // (name, resolvable fallback expression, where) triples, collected from
  // `parseIntVar` calls and from the option objects that feed `dailyBudget`.
  const fallbacks = [];

  for (const [file, text] of sources) {
    const localConsts = new Map([...text.matchAll(CONST_DECL_RE)].map((m) => [m[1], m[2]]));

    for (const m of text.matchAll(ENV_MEMBER_RE)) noteRead(m[1], `${file}:${lineOf(text, m.index)}`);
    for (const m of text.matchAll(VAR_PROPERTY_RE)) noteRead(m[1], `${file}:${lineOf(text, m.index)}`);
    for (const union of text.matchAll(VAR_UNION_RE)) {
      for (const member of union[1].matchAll(QUOTED_VAR_RE)) {
        noteRead(member[1], `${file}:${lineOf(text, union.index)}`);
      }
    }

    for (const m of text.matchAll(PARSE_INT_VAR_NAME_RE)) {
      const where = `${file}:${lineOf(text, m.index)}`;
      noteRead(m[1], where);
      const args = callArguments(text, text.indexOf("(", m.index));
      if (args !== null && args.length >= 3) fallbacks.push({ name: m[1], expr: args[2], where, localConsts });
    }

    // `dailyBudget({ … ipDailyLimitVar: "REPORT_IP_DAILY_BUDGET",
    // fallbackIpDailyLimit: DEFAULT_REPORT_IP_DAILY_BUDGET })` — the name and
    // the fallback are siblings in one object literal, so pair them within it.
    for (const m of text.matchAll(VAR_PROPERTY_RE)) {
      const close = text.indexOf("}", m.index);
      const window = text.slice(m.index, close === -1 ? m.index + 200 : close);
      const fallback = /fallback[A-Za-z_$][\w$]*\s*:\s*([^,}\n]+)/.exec(window);
      if (fallback) {
        fallbacks.push({ name: m[1], expr: fallback[1], where: `${file}:${lineOf(text, m.index)}`, localConsts });
      }
    }

    for (const m of text.matchAll(COMPUTED_ENV_RE)) {
      const key = m[1].trim();
      if (/Var\b/.test(key) || /binding/i.test(key)) continue;
      details.push(
        `${file}:${lineOf(text, m.index)}: computed env[${key}] — this check cannot tell which var that reads, ` +
          `so it would under-report. Name the key through a \`…Var\` type (like IpDailyLimitVar) or a \`…binding…\` identifier.`,
      );
    }
  }

  for (const [name, where] of [...readAt].sort()) {
    if (declared.has(name) || bindings.has(name) || secrets.has(name)) continue;
    details.push(
      `${name}: read at ${where} but declared in no [vars] block of ${WRANGLER_PATH} — ` +
        `it runs at the code fallback and cannot be changed without a deploy`,
    );
  }

  for (const name of [...declared.keys()].sort()) {
    if (readAt.has(name)) continue;
    details.push(
      `${name}: declared in ${WRANGLER_PATH} but read nowhere under ${API_SRC_DIR} — ` +
        `configuration that cannot change behavior (see MAX_PHOTOS/IMAGE_TRANSFORMS_ENABLED, removed 2026-09-06)`,
    );
  }

  let compared = 0;
  for (const { name, expr, where, localConsts } of fallbacks) {
    const declaredValue = declared.get(name);
    if (declaredValue === undefined) continue; // already reported above
    const fallbackValue = resolveNumericExpr(expr, localConsts, globalConsts);
    if (fallbackValue === undefined) continue;
    const declaredNumber = Number.parseInt(declaredValue, 10);
    if (!Number.isFinite(declaredNumber)) continue;
    compared += 1;
    if (fallbackValue !== declaredNumber) {
      details.push(
        `${name}: ${WRANGLER_PATH} [vars] declares ${declaredNumber} but ${where} falls back to ${fallbackValue} — ` +
          `the declared number is not what runs when the var is unset or unparseable`,
      );
    }
  }

  if (details.length > 0) return { status: "fail", details };
  return {
    status: "pass",
    details: [
      `${declared.size} var(s) in ${WRANGLER_PATH} [vars]: all read under ${API_SRC_DIR}, ` +
        `all reads declared, ${compared} code fallback(s) equal to the declared value`,
    ],
  };
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

/** Is `git lfs` usable from here at all? */
export function gitLfsInstalled() {
  return spawnSync("git", ["lfs", "version"], { encoding: "utf8" }).status === 0;
}

/**
 * A pointer file means one of two very different things, and the old message
 * ("unfetched LFS pointer — run: git lfs install && git lfs pull") read like
 * the seed itself was corrupt in both.
 *
 * In an agent container git-lfs is simply not installed, so `git clone` wrote
 * the 130-byte pointer and there was never a moment at which the real file
 * could have arrived. Nothing is wrong with the repository, and the suggested
 * command cannot work — `git lfs install` is not a git subcommand here.
 *
 * In CI the checkout is `lfs: true` (`.github/workflows/ci.yml`'s preflight
 * job) and git-lfs is on the runner, so a pointer at this point is a real
 * defect: the smudge filter was skipped or the fetch failed, and preflight is
 * reading 130 bytes where 2.8 MB of postal codes should be. Both stay a
 * FAIL — a seed file that is not the seed file is not a passing state
 * anywhere — but they are told apart so nobody debugs the wrong one.
 */
export function lfsPointerDetail(file, lfsInstalled) {
  return lfsInstalled
    ? `${file}: unfetched LFS pointer — git-lfs IS installed here, so the object was never pulled (a skipped smudge filter, a shallow/partial clone, or a failed fetch). Run: git lfs install && git lfs pull`
    : `${file}: unfetched LFS pointer, and git-lfs is NOT installed here (\`git lfs version\` fails) — the file in the repository is fine, this environment simply cannot materialize it. Install git-lfs first, then run: git lfs install && git lfs pull`;
}

export function checkLfsPointers(ctx, lfsInstalled = gitLfsInstalled()) {
  if (!ctx.exists(SEEDS_DIR)) return { status: "skip", details: [`${SEEDS_DIR} not present`] };
  const files = ctx.walk(SEEDS_DIR).filter((f) => f.endsWith(".sql"));
  if (files.length === 0) return { status: "skip", details: [`${SEEDS_DIR} has no *.sql files yet`] };

  const details = [];
  for (const file of files) {
    const text = ctx.readText(file) ?? "";
    if (text.startsWith(LFS_POINTER_PREFIX)) {
      details.push(lfsPointerDetail(file, lfsInstalled));
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

// ── shell-syntax ───────────────────────────────────────────────────────────
//
// Issue #166. This check used to glob `tools/**` and `.github/**` for `*.sh`
// and skip when there were none. There has never been a `.sh` file in this
// repository — not in the working tree, not anywhere in git history — so the
// check had skipped every time it had ever run, and it is named for catching
// exactly the failure that #106 was: a shell parse error in `uptime.yml` kills
// the only monitor of the live site, and because its alerting step is
// `if: failure() && steps.check.outputs.failures != ''` and `failures` is
// never written when the script dies at parse time, **no issue is filed**.
//
// All of this repo's shell is inline in workflow `run:` blocks — uptime's
// probe and `gh issue` alerting, deploy's commit verification,
// report-pressure's dedupe. So the check now extracts those blocks and runs
// `bash -n` on each, and keeps the `*.sh` glob for whenever one appears.
//
// Two deliberate choices:
//
//   1. **"Nothing to check" is a failure, not a skip**, whenever the workflows
//      do contain `run:` blocks. A check whose "nothing to do" state is
//      indistinguishable from "I am misconfigured" is what let this sit for
//      the whole life of the repository. The only remaining skip is the
//      honest one: no `.sh` files *and* no `.github/workflows` at all, which
//      is a fixture tree or a monorepo path that has not landed yet.
//   2. `${{ … }}` is replaced with a placeholder word rather than left in
//      place. GitHub substitutes those before the shell ever sees them, so
//      parsing them literally would report syntax errors that do not exist at
//      run time. The placeholder is a bare word, which is what an
//      unquoted expression expands to in practice.
//
// Known gap, stated rather than papered over: `bash -n` is a *parse*, so it
// catches an unbalanced `fi`/`done`/quote and nothing else. A step whose
// `shell:` is not bash/sh (python, pwsh, node) is listed as not-parsed rather
// than silently ignored.

// GitHub expressions are substituted before the shell runs; parse a
// placeholder in their place.
const GHA_EXPRESSION_RE = /\$\{\{[\s\S]*?\}\}/g;
const GHA_EXPRESSION_PLACEHOLDER = "GHA_EXPR";
// `bash`, `sh`, and the `bash -e {0}`/`bash --noprofile … {0}` custom forms.
const PARSEABLE_SHELL_RE = /^(?:\/usr\/bin\/env\s+)?(?:bash|sh)(?:\s|$)/;

function indentWidth(line) {
  return line.length - line.trimStart().length;
}

/**
 * Every `run:` block in a workflow file, without a YAML parser.
 *
 * This module imports node builtins only, on purpose (see `splitWorkflowJobs`
 * below for why `yaml` is not available to lean on), so this walks the same
 * indentation shape that function already trusts.
 *
 * Returns `[{ line, firstScriptLine, shell, script }]` — `line` is the
 * 1-based line of the `run:` key, `firstScriptLine` the 1-based line the
 * returned script's first line came from (so `bash -n`'s "line N" can be
 * mapped back onto the workflow file), and `shell` the step's `shell:` value
 * or `null` when it takes the runner default.
 */
export function extractWorkflowRunBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];

  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s*)(-\s+)?run:(.*)$/.exec(lines[i]);
    if (!match) continue;
    const keyIndent = match[1].length + (match[2]?.length ?? 0);
    const rest = (match[3] ?? "").trim();

    let script;
    let firstScriptLine;
    let endLine = i;

    const blockScalar = /^([|>])([+-]?)(\d*)$|^([|>])(\d*)([+-]?)$/.exec(rest);
    if (blockScalar) {
      const folded = rest.startsWith(">");
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        if (lines[j].trim() === "") {
          body.push("");
          continue;
        }
        if (indentWidth(lines[j]) <= keyIndent) break;
        body.push(lines[j]);
      }
      endLine = j - 1;
      // Trailing blank lines belong to the next key, not to this script.
      while (body.length > 0 && body[body.length - 1] === "") body.pop();
      const contentIndents = body.filter((l) => l !== "").map(indentWidth);
      const strip = contentIndents.length > 0 ? Math.min(...contentIndents) : 0;
      const dedented = body.map((l) => (l === "" ? "" : l.slice(strip)));
      script = folded ? foldYamlScalar(dedented) : dedented.join("\n");
      firstScriptLine = i + 2;
    } else if (rest === "") {
      continue; // `run:` with nothing after it — not shell, and YAML wouldn't accept it either.
    } else {
      script = unquoteYamlScalar(rest);
      firstScriptLine = i + 1;
    }

    blocks.push({
      line: i + 1,
      firstScriptLine,
      shell: stepShell(lines, i, endLine, keyIndent),
      script,
    });
    i = endLine;
  }

  return blocks;
}

/** YAML folded (`>`) scalars join consecutive non-blank lines with a space. */
function foldYamlScalar(bodyLines) {
  const out = [];
  let buffer = [];
  for (const line of bodyLines) {
    if (line === "") {
      if (buffer.length > 0) out.push(buffer.join(" "));
      buffer = [];
      out.push("");
    } else {
      buffer.push(line);
    }
  }
  if (buffer.length > 0) out.push(buffer.join(" "));
  return out.join("\n");
}

function unquoteYamlScalar(value) {
  const double = /^"([\s\S]*)"$/.exec(value);
  if (double) return double[1].replace(/\\"/g, '"');
  const single = /^'([\s\S]*)'$/.exec(value);
  if (single) return single[1].replace(/''/g, "'");
  return value;
}

/**
 * The `shell:` a step declares, or `null` for the runner default (bash on
 * ubuntu). Sibling keys of `run:` sit at the same indentation; the step's own
 * list marker sits two columns left of them.
 */
function stepShell(lines, runLine, runEndLine, keyIndent) {
  const readShell = (line) => {
    const m = /^(?:-\s+)?shell:\s*(.+?)\s*$/.exec(line.trim());
    return m ? unquoteYamlScalar(m[1]) : null;
  };

  const scan = (from, to, step) => {
    for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
      const line = lines[i];
      if (line === undefined || line.trim() === "") continue;
      const indent = indentWidth(line);
      if (indent > keyIndent) continue; // nested under a sibling key (an `env:` map, say)
      if (indent === keyIndent) {
        const shell = readShell(line);
        if (shell) return shell;
        continue;
      }
      // Left of the sibling keys: the step's own `- ` marker ends the step.
      if (line.trim().startsWith("- ") && indent + 2 === keyIndent) return readShell(line);
      return null;
    }
    return null;
  };

  return scan(runLine - 1, 0, -1) ?? scan(runEndLine + 1, lines.length - 1, 1);
}

function checkShellSyntax(ctx) {
  const scripts = [...ctx.walk("tools"), ...ctx.walk(".github")].filter((f) => f.endsWith(".sh"));
  const workflowFiles = ctx.exists(WORKFLOWS_DIR)
    ? ctx.walk(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f))
    : [];

  const units = [];
  for (const script of scripts) {
    units.push({ label: script, script: ctx.readText(script) ?? "", firstScriptLine: 1 });
  }

  let filesWithRunText = 0;
  let runBlocks = 0;
  const notParsed = [];
  for (const file of workflowFiles) {
    const text = ctx.readText(file) ?? "";
    if (/^\s*(?:-\s+)?run:/m.test(text)) filesWithRunText += 1;
    for (const block of extractWorkflowRunBlocks(text)) {
      runBlocks += 1;
      if (block.shell !== null && !PARSEABLE_SHELL_RE.test(block.shell)) {
        notParsed.push(`${file}:${block.line}: shell: ${block.shell} — not parsed by bash -n`);
        continue;
      }
      units.push({
        label: `${file}:${block.line}`,
        script: block.script.replace(GHA_EXPRESSION_RE, GHA_EXPRESSION_PLACEHOLDER),
        firstScriptLine: block.firstScriptLine,
      });
    }
  }

  // The whole point of #166: "found nothing" must be loud. The one honest
  // skip is a tree with neither shell scripts nor workflows.
  if (scripts.length === 0 && workflowFiles.length === 0) {
    return { status: "skip", details: [`no *.sh files under tools/ or .github/, and no ${WORKFLOWS_DIR}`] };
  }
  if (units.length === 0) {
    return {
      status: "fail",
      details: [
        filesWithRunText > 0
          ? `${filesWithRunText} workflow file(s) under ${WORKFLOWS_DIR} contain \`run:\` blocks but this check extracted none — the extractor is broken, so it has been parsing nothing. It must not report "nothing to do" while the shell that alerts us the site is down goes unchecked (#166).`
          : `no shell found at all: 0 *.sh files under tools/ or .github/ and 0 \`run:\` blocks across ${workflowFiles.length} workflow file(s). If that is genuinely true, this check has nothing to guard and should be removed rather than left skipping (#166).`,
      ],
    };
  }

  const details = [];
  for (const unit of units) {
    const result = spawnSync("bash", ["-n"], { input: unit.script, encoding: "utf8" });
    if (result.status === 0) continue;
    const stderr = (result.stderr || "").trim();
    const message = (stderr.split("\n").pop() || "bash -n failed")
      // bash counts lines from the start of what it was handed; say where that
      // is in the workflow file instead.
      .replace(/^bash: line (\d+):/, (_, n) => `line ${unit.firstScriptLine + Number(n) - 1}:`);
    details.push(`${unit.label}: ${message}`);
  }

  if (details.length > 0) {
    details.push(
      "A workflow whose shell does not parse dies on its first run — and uptime.yml's alerting step " +
        "is gated on an output the dead script never writes, so nobody is told (#106, #166).",
    );
    return { status: "fail", details };
  }
  const summary = [
    `${scripts.length} shell script(s) and ${runBlocks - notParsed.length} workflow \`run:\` block(s) parse (bash -n), across ${workflowFiles.length} workflow file(s)`,
  ];
  for (const skipped of notParsed) summary.push(skipped);
  return { status: "pass", details: summary };
}

// ── gh-repo-context ────────────────────────────────────────────────────────

const WORKFLOWS_DIR = ".github/workflows";

/**
 * Split a workflow file into its `jobs:` blocks without a YAML parser.
 *
 * This file imports node builtins only, on purpose — it must run standalone,
 * and its tests point it at fixture trees in `os.tmpdir()`. `yaml` is not a
 * declared dependency of this repo (only a transitive one), so it is not
 * available to lean on. Workflow YAML is regular enough to split by
 * indentation, the same trade `parseToml` above already makes.
 *
 * Returns `[{ name, lines }]`, one entry per top-level key under `jobs:`.
 */
function splitWorkflowJobs(text) {
  const lines = text.split("\n");
  const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsAt === -1) return [];

  const jobs = [];
  let current = null;
  for (let i = jobsAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\S/.test(line) && line.trim() !== "") break; // back to a top-level key
    const header = /^ {2}([A-Za-z_][A-Za-z0-9_-]*):\s*$/.exec(line);
    if (header) {
      current = { name: header[1], lines: [] };
      jobs.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return jobs;
}

/** `gh` invoked as a command, not the letters "gh" inside another word. */
const GH_INVOCATION = /(?:^|[|&;(`$\s])gh\s+[a-z]/;

/**
 * A workflow step that shells out to `gh` needs to know which repository it
 * is acting on. `gh` derives that from the git remote, so a job containing an
 * `actions/checkout` step has it for free — and a job without one has nothing
 * unless `GH_REPO` is set.
 *
 * Getting this wrong does not degrade an alert, it silently removes it: every
 * `gh` call exits non-zero with "failed to run git: fatal: not a git
 * repository". `uptime.yml` shipped exactly that, and because its alerting
 * step is `if: failure()` — it only runs when something is genuinely wrong —
 * it had never once succeeded in filing an issue (#106). The workflow ran on
 * schedule, probed both tiers correctly and went red the whole time; the step
 * that turns a red run into a notification a human receives was dead.
 *
 * Deliberately coarse: any `gh <subcommand>` in a `run:` block counts, and a
 * checkout anywhere in the job counts as context. A false positive is
 * silenced by setting `GH_REPO`; a false negative is an alert nobody gets.
 */
function checkGhRepoContext(ctx) {
  if (!ctx.exists(WORKFLOWS_DIR)) {
    return { status: "skip", details: [`${WORKFLOWS_DIR} not present`] };
  }
  const files = ctx.walk(WORKFLOWS_DIR).filter((f) => /\.ya?ml$/.test(f));
  if (files.length === 0) {
    return { status: "skip", details: [`no workflow files under ${WORKFLOWS_DIR}`] };
  }

  const details = [];
  let jobsUsingGh = 0;

  for (const file of files) {
    const text = ctx.readText(file) ?? "";
    // A repo-wide `env:` at the top level applies to every job in the file.
    const topLevelGhRepo = /^env:\s*$[\s\S]*?^ {2}GH_REPO:/m.test(text);

    for (const job of splitWorkflowJobs(text)) {
      const body = job.lines.join("\n");
      if (!GH_INVOCATION.test(body)) continue;
      jobsUsingGh += 1;
      if (body.includes("actions/checkout")) continue;
      if (body.includes("GH_REPO:") || topLevelGhRepo) continue;
      details.push(
        `${file}: job "${job.name}" runs \`gh\` with no actions/checkout in the job and no ` +
          "GH_REPO in scope — gh cannot resolve the repository, so every call fails with " +
          '"fatal: not a git repository". Set GH_REPO: ${{ github.repository }}.',
      );
    }
  }

  if (details.length > 0) return { status: "fail", details };
  return {
    status: "pass",
    details: [
      `${jobsUsingGh} job(s) invoking gh across ${files.length} workflow file(s), all with repo context`,
    ],
  };
}

export const CHECKS = {
  fonts: { description: "@font-face url(/fonts/*) vs apps/web/public/fonts/*.ttf", run: checkFonts },
  migrations: { description: "apps/api/migrations/*.sql naming, apply order and terminators", run: checkMigrations },
  "migration-drift": { description: "no landed migration is renamed/edited/deleted (git)", run: checkMigrationDrift },
  "env-parity": { description: ".env.example vs wrangler.toml [vars] / [env.*.vars]", run: checkEnvParity },
  "var-usage": { description: "wrangler.toml [vars] vs what apps/api/src reads and falls back to", run: checkVarUsage },
  "cron-triggers": { description: "every tier resolves valid crons, all handled by scheduled()", run: checkCronTriggers },
  models: { description: '"@cf/" model ids confined to apps/api/src/models.ts', run: checkModels },
  "ip-digest": { description: "client-IP hashes rotate daily via lib/digest.ts's dailyIpDigest", run: checkIpDigest },
  exports: { description: "packages/*/package.json subpath exports (no \".\")", run: checkExports },
  routes: { description: "apps/web/app/**/*.tsx export a default component", run: checkRoutes },
  "conflict-markers": { description: "no unresolved <<<<<<< / >>>>>>> in tracked text", run: checkConflictMarkers },
  "lfs-pointers": { description: "apps/api/seeds/*.sql are not unfetched LFS pointers", run: checkLfsPointers },
  "public-env": { description: "EXPO_PUBLIC_* names are never secrets", run: checkPublicEnv },
  "gh-repo-context": { description: "workflow steps running `gh` can resolve the repo", run: checkGhRepoContext },
  "shell-syntax": { description: "bash -n on every workflow `run:` block and every *.sh under tools/ and .github/", run: checkShellSyntax },
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

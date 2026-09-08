// Tests for tools/preflight/preflight.mjs.
//
// Each check gets a fixture tree built fresh under os.tmpdir(): one "good"
// tree it passes against, and a minimal mutation that makes it fail. A check
// that only ever runs against a green tree cannot tell you it still works —
// see finderly's "tests asserting source text stayed green" lesson (this
// repo's build plan carries that lesson forward on purpose).
//
// Run with: node --test tools/preflight/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  runChecks,
  createContext,
  parseEnvExample,
  parseToml,
  migrationApplyOrder,
  parseCronTriggers,
  cronExpressionProblem,
  scheduledCronCases,
  scheduledCronDispatch,
  parseCronRegistry,
  cronIntervalMs,
  tablesAfterMigrations,
  documentedBackupTables,
  cspHashesIn,
  templateLiteralBody,
  inlineScriptBodies,
  checkLfsPointers,
  lfsPointerDetail,
  resolveNumericExpr,
  callArguments,
  extractWorkflowRunBlocks,
  fontVersionToken,
} from "./preflight.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREFLIGHT_BIN = path.join(HERE, "preflight.mjs");
// Some checks are only meaningful against the real tree — a fixture can prove
// the logic works and still leave the repository's own bytes unexamined,
// which is exactly what #166 found.
const REPO_ROOT = path.resolve(HERE, "../..");

function makeTree(files) {
  const root = mkdtempSync(path.join(tmpdir(), "keepsake-preflight-"));
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(root, relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function runOne(name, files) {
  const root = makeTree(files);
  try {
    return runChecks([name], root)[0];
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── fonts ──────────────────────────────────────────────────────────────

/** The token the fixture tree's fonts hash to. Both formats of both faces
 * count: replacing either has to move the token. */
const FIXTURE_FONT_FILES = [
  ["Fraunces.ttf", Buffer.from("x")],
  ["Fraunces.woff2", Buffer.from("w")],
  ["Inter.ttf", Buffer.from("x")],
  ["Inter.woff2", Buffer.from("w")],
];
const FIXTURE_TOKEN = fontVersionToken(FIXTURE_FONT_FILES);
const FIXTURE_FONT_TREE = {
  "apps/web/public/fonts/Fraunces.ttf": "x",
  "apps/web/public/fonts/Fraunces.woff2": "w",
  "apps/web/public/fonts/Inter.ttf": "x",
  "apps/web/public/fonts/Inter.woff2": "w",
};

/** `+html.tsx` as it really is: a FONT_VERSION constant, `?v=${FONT_VERSION}`
 * inside the CSS template literal, woff2 ahead of the ttf fallback, and the
 * same token on the preload links. */
function htmlGood({ version = FIXTURE_TOKEN, css = null } = {}) {
  return `
  const FONT_VERSION = "${version}";
  <style>
    ${css ?? `@font-face { font-family: Fraunces; src: url(/fonts/Fraunces.woff2?v=\${FONT_VERSION}) format("woff2"), url(/fonts/Fraunces.ttf?v=\${FONT_VERSION}); }
    @font-face { font-family: Inter; src: url("/fonts/Inter.woff2?v=\${FONT_VERSION}") format("woff2"), url("/fonts/Inter.ttf?v=\${FONT_VERSION}"); }`}
  </style>
`;
}

const SITE_CSS_GOOD = `@font-face { src: url("/fonts/Fraunces.woff2?v=${FIXTURE_TOKEN}") format("woff2"), url("/fonts/Fraunces.ttf?v=${FIXTURE_TOKEN}"); }`;

test("fonts: passes when every referenced font exists and every font is referenced", () => {
  const result = runOne("fonts", { "apps/web/app/+html.tsx": htmlGood(), ...FIXTURE_FONT_TREE });
  assert.equal(result.status, "pass");
});

test("fonts: fails when a referenced font file is missing", () => {
  const withoutInterWoff2 = { ...FIXTURE_FONT_TREE };
  delete withoutInterWoff2["apps/web/public/fonts/Inter.woff2"];
  const result = runOne("fonts", { "apps/web/app/+html.tsx": htmlGood(), ...withoutInterWoff2 });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /Inter\.woff2/);
});

test("fonts: warns on an unreferenced ttf without failing", () => {
  // Extra.ttf is unreferenced AND changes the hash of what is on disk, so the
  // fixture's token has to be computed over all three or this "warn" case
  // would fail on the token instead.
  const files = [...FIXTURE_FONT_FILES, ["Extra.ttf", Buffer.from("x")]];
  const result = runOne("fonts", {
    "apps/web/app/+html.tsx": htmlGood({ version: fontVersionToken(files) }),
    ...FIXTURE_FONT_TREE,
    "apps/web/public/fonts/Extra.ttf": "x",
  });
  assert.equal(result.status, "warn");
  assert.match(result.details.join("\n"), /Extra\.ttf/);
});

// The three cases below are the whole point of the `?v=` token: `_headers`
// serves /fonts/* `immutable` for a year under filenames that never change,
// so a font replaced in place is invisible to every returning visitor. Each
// mutation here is one a real change would make.

test("fontVersionToken: a font it could not read is null, not a thrown hash", () => {
  // `ctx.readBytes` answers `null` for a file it cannot read — a broken
  // symlink, a permission, an LFS pointer nobody fetched (this repo already
  // has one of those). Handing that to `hash.update()` throws, and the runner
  // reports a thrown check as "check itself threw" with a stack that does not
  // say which font. `checkFonts` filters and names them; this is the second
  // line of defence.
  assert.equal(fontVersionToken([["Fraunces.ttf", null]]), null);
  assert.equal(fontVersionToken([["Fraunces.ttf", Buffer.from("x")], ["Inter.woff2", null]]), null);
  assert.equal(typeof fontVersionToken([["Fraunces.ttf", Buffer.from("x")]]), "string");
});

test("fonts: fails when a font is replaced but FONT_VERSION is not bumped", () => {
  const result = runOne("fonts", {
    "apps/web/app/+html.tsx": htmlGood(),
    ...FIXTURE_FONT_TREE,
    // Different bytes → a different hash → the declared token is now stale.
    "apps/web/public/fonts/Fraunces.woff2": "a new cut of Fraunces",
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /FONT_VERSION is/);
});

test("fonts: fails when a reference carries no ?v= token at all", () => {
  const result = runOne("fonts", {
    "apps/web/app/+html.tsx": htmlGood({
      css: '@font-face { src: url("/fonts/Fraunces.woff2"); }\n    @font-face { src: url("/fonts/Inter.woff2?v=${FONT_VERSION}"); }',
    }),
    ...FIXTURE_FONT_TREE,
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /no \?v= token/);
});

test("fonts: fails when site.css's copy of the token goes stale", () => {
  // The static marketing stylesheet has no build step, so it repeats the
  // token by hand — the copy most likely to be forgotten.
  const result = runOne("fonts", {
    "apps/web/app/+html.tsx": htmlGood(),
    "apps/site/public/site.css": '@font-face { src: url("/fonts/Fraunces.woff2?v=0badcafe"); }',
    ...FIXTURE_FONT_TREE,
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /site\.css references \/fonts\/Fraunces\.woff2 at \?v=0badcafe/);
});

test("fonts: passes with site.css carrying the same token", () => {
  const result = runOne("fonts", {
    "apps/web/app/+html.tsx": htmlGood(),
    "apps/site/public/site.css": SITE_CSS_GOOD,
    ...FIXTURE_FONT_TREE,
  });
  assert.equal(result.status, "pass");
});

test("fonts: fails when the ttf fallback is listed ahead of the woff2", () => {
  // `src:` is an ordered list and a browser stops at the first format it
  // supports, so this ships 360 KB of TTF to everyone while looking, in a
  // diff, like a font declaration that mentions woff2.
  const result = runOne("fonts", {
    "apps/web/app/+html.tsx": htmlGood({
      css: '@font-face { src: url("/fonts/Fraunces.ttf?v=${FONT_VERSION}"), url("/fonts/Fraunces.woff2?v=${FONT_VERSION}"); }\n    @font-face { src: url("/fonts/Inter.woff2?v=${FONT_VERSION}") format("woff2"), url("/fonts/Inter.ttf?v=${FONT_VERSION}"); }',
    }),
    ...FIXTURE_FONT_TREE,
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /no \/fonts\/Fraunces\.woff2 ahead of it/);
});

test("fonts: skips when +html.tsx is not present", () => {
  const result = runOne("fonts", {});
  assert.equal(result.status, "skip");
});

// ── migrations ─────────────────────────────────────────────────────────

function migrationTree(overrides = {}) {
  return {
    "apps/api/migrations/0001_init.sql": "CREATE TABLE a (id TEXT);\n",
    "apps/api/migrations/0002_geo.sql": "CREATE TABLE b (id TEXT);\n",
    ...overrides,
  };
}

test("migrations: passes on contiguous, semicolon-terminated files", () => {
  const result = runOne("migrations", migrationTree());
  assert.equal(result.status, "pass");
});

test("migrations: fails on a gap in numbering", () => {
  const result = runOne("migrations", {
    "apps/api/migrations/0001_init.sql": "CREATE TABLE a (id TEXT);\n",
    "apps/api/migrations/0003_fts.sql": "CREATE TABLE b (id TEXT);\n",
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /gap|0002/);
});

test("migrations: fails on a duplicate prefix", () => {
  const result = runOne("migrations", {
    "apps/api/migrations/0001_init.sql": "CREATE TABLE a (id TEXT);\n",
    "apps/api/migrations/0001_other.sql": "CREATE TABLE b (id TEXT);\n",
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /duplicate/);
});

test("migrations: fails when a statement is not terminated with a semicolon", () => {
  const result = runOne("migrations", {
    "apps/api/migrations/0001_init.sql": "CREATE TABLE a (id TEXT)\n-- trailing comment\n",
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /does not end with/);
});

test("migrations: a trailing comment after the semicolon is fine", () => {
  const result = runOne("migrations", {
    "apps/api/migrations/0001_init.sql": "CREATE TABLE a (id TEXT);\n-- trailing comment\n",
  });
  assert.equal(result.status, "pass");
});

test("migrations: skips when the directory is absent", () => {
  const result = runOne("migrations", {});
  assert.equal(result.status, "skip");
});

test("migrations: accepts the legacy block alongside timestamped migrations", () => {
  const result = runOne("migrations", {
    "apps/api/migrations/0001_init.sql": "CREATE TABLE a (id TEXT);\n",
    "apps/api/migrations/0002_geo.sql": "CREATE TABLE b (id TEXT);\n",
    "apps/api/migrations/20260907120000_notify_failed.sql": "ALTER TABLE a ADD COLUMN x TEXT;\n",
  });
  assert.equal(result.status, "pass");
  assert.match(result.details.join("\n"), /2 legacy 0001-contiguous, 1 timestamped/);
});

test("migrations: fails on a name that is neither NNNN_ nor a 14-digit timestamp", () => {
  const result = runOne("migrations", {
    "apps/api/migrations/0001_init.sql": "CREATE TABLE a (id TEXT);\n",
    "apps/api/migrations/add_a_column.sql": "ALTER TABLE a ADD COLUMN x TEXT;\n",
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /YYYYMMDDHHMMSS_slug\.sql/);
});

test("migrations: fails on a 14-digit prefix that is not a real UTC instant", () => {
  const result = runOne("migrations", {
    "apps/api/migrations/0001_init.sql": "CREATE TABLE a (id TEXT);\n",
    "apps/api/migrations/20261307120000_oops.sql": "ALTER TABLE a ADD COLUMN x TEXT;\n",
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /month 13 is not 01-12/);
});

test("migrations: a duplicate prefix explains why renaming one is not the fix", () => {
  const result = runOne("migrations", {
    "apps/api/migrations/0001_init.sql": "CREATE TABLE a (id TEXT);\n",
    "apps/api/migrations/0002_mine.sql": "CREATE TABLE b (id TEXT);\n",
    "apps/api/migrations/0002_theirs.sql": "CREATE TABLE c (id TEXT);\n",
  });
  assert.equal(result.status, "fail");
  const text = result.details.join("\n");
  assert.match(text, /duplicate migration prefix 0002/);
  assert.match(text, /d1_migrations/);
  // The old code also emitted a bogus "gap" line for the duplicate; it should
  // report the duplicate once and nothing else.
  assert.doesNotMatch(text, /gap/);
});

// The order wrangler actually applies migrations in: `parseInt` on the leading
// segment, not a string sort. `0009` before `20260101000000` is the property
// the whole two-scheme arrangement rests on.
test("migrationApplyOrder sorts numerically, legacy before timestamped", () => {
  const order = migrationApplyOrder([
    "20260101000000_b.sql",
    "0010_ten.sql",
    "0009_nine.sql",
    "20250101000000_a.sql",
    "0001_init.sql",
  ]);
  assert.deepEqual(order, [
    "0001_init.sql",
    "0009_nine.sql",
    "0010_ten.sql",
    "20250101000000_a.sql",
    "20260101000000_b.sql",
  ]);
});

// ── migration-drift ────────────────────────────────────────────────────
//
// These need real git history, so each builds a throwaway repository with an
// `origin/main` ref planted by `git update-ref` — no network, no remote.

function git(root, ...args) {
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// Commits `files` as `main`, points `refs/remotes/origin/main` at it, then
// checks out a branch and applies `branchFiles` (a map of path -> string to
// write, or `null` to delete) — committing them when `commitBranch` is set.
function makeGitRepo({ main: mainFiles, branch: branchFiles = {}, commitBranch = false, plantOriginMain = true }) {
  const root = makeTree(mainFiles);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "preflight@example.com");
  git(root, "config", "user.name", "preflight test");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "main");
  if (plantOriginMain) git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  if (Object.keys(branchFiles).length > 0 || commitBranch) {
    git(root, "checkout", "-q", "-b", "feature");
    for (const [rel, content] of Object.entries(branchFiles)) {
      const abs = path.join(root, rel);
      if (content === null) rmSync(abs, { force: true });
      else {
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
    }
    if (commitBranch) {
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "feature");
    }
  }
  return root;
}

function runDrift(options) {
  const root = makeGitRepo(options);
  try {
    return runChecks(["migration-drift"], root)[0];
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const LANDED = {
  "apps/api/migrations/0001_init.sql": "CREATE TABLE requests (id TEXT);\n",
  "apps/api/migrations/0007_admin_request_removal.sql": "ALTER TABLE requests ADD COLUMN removed_at TEXT;\n",
};

test("migration-drift: passes when nothing that landed on origin/main moved", () => {
  const result = runDrift({ main: LANDED });
  assert.equal(result.status, "pass");
});

test("migration-drift: fails when a landed migration's contents are edited", () => {
  const result = runDrift({
    main: LANDED,
    branch: {
      "apps/api/migrations/0007_admin_request_removal.sql":
        "ALTER TABLE requests ADD COLUMN removed_at TEXT;\nALTER TABLE requests ADD COLUMN sneaky TEXT;\n",
    },
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /edited after landing on origin\/main/);
});

test("migration-drift: fails when a landed migration is renamed", () => {
  const result = runDrift({
    main: LANDED,
    branch: {
      "apps/api/migrations/0007_admin_request_removal.sql": null,
      "apps/api/migrations/0008_admin_request_removal.sql": "ALTER TABLE requests ADD COLUMN removed_at TEXT;\n",
    },
    commitBranch: true,
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /renamed after landing on origin\/main|deleted after landing on origin\/main/);
  assert.match(result.details.join("\n"), /d1_migrations/);
});

test("migration-drift: fails when a landed migration is deleted", () => {
  const result = runDrift({
    main: LANDED,
    branch: { "apps/api/migrations/0007_admin_request_removal.sql": null },
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /deleted after landing on origin\/main/);
});

test("migration-drift: fails when a new migration uses the legacy sequential form", () => {
  const result = runDrift({
    main: LANDED,
    branch: { "apps/api/migrations/0008_notify_failed.sql": "ALTER TABLE requests ADD COLUMN n TEXT;\n" },
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /must be named YYYYMMDDHHMMSS_slug\.sql/);
});

test("migration-drift: passes when a new migration is timestamped", () => {
  const result = runDrift({
    main: LANDED,
    branch: { "apps/api/migrations/20260907120000_notify_failed.sql": "ALTER TABLE requests ADD COLUMN n TEXT;\n" },
  });
  assert.equal(result.status, "pass");
  assert.match(result.details.join("\n"), /1 added, all timestamped/);
});

// The #99 sequence itself: the branch adds a migration, pushes (so the shared
// preview D1 applies it), then a rebase forces a rename. Nothing on
// origin/main moved, so only the branch's own history can catch this.
test("migration-drift: fails when a migration this branch already committed is renamed away", () => {
  const root = makeGitRepo({
    main: LANDED,
    branch: { "apps/api/migrations/20260907120000_notify_failed.sql": "ALTER TABLE requests ADD COLUMN n TEXT;\n" },
    commitBranch: true,
  });
  try {
    assert.equal(runChecks(["migration-drift"], root)[0].status, "pass");
    git(root, "mv",
      "apps/api/migrations/20260907120000_notify_failed.sql",
      "apps/api/migrations/20260908120000_notify_failed.sql");
    git(root, "commit", "-q", "-m", "renumber on rebase");
    const result = runChecks(["migration-drift"], root)[0];
    assert.equal(result.status, "fail");
    assert.match(result.details.join("\n"), /committed on this branch and then removed or renamed/);
    assert.match(result.details.join("\n"), /20260907120000_notify_failed\.sql/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A check that cannot run must say so, not pass. Locally that is a SKIP;
// anywhere the baseline is guaranteed fetchable it is a FAIL.
/**
 * Run `fn` with specific environment variables forced on or off.
 *
 * `migration-drift` escalates its SKIP to a FAIL when it detects CI
 * (`GITHUB_ACTIONS=true`) or an explicit `PREFLIGHT_REQUIRE_GIT_BASELINE=1`,
 * so any test asserting *either* outcome has to state which world it is in.
 * Inheriting the ambient value means a test that passes on a laptop fails on a
 * runner, which is exactly what happened: two of these went green locally and
 * red in CI, because GitHub always sets GITHUB_ACTIONS=true.
 */
function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** No baseline required: the world a contributor's laptop is in. */
const NO_BASELINE_REQUIRED = { GITHUB_ACTIONS: undefined, PREFLIGHT_REQUIRE_GIT_BASELINE: undefined };

test("migration-drift: skips with a reason when origin/main cannot be resolved", () => {
  const result = withEnv(NO_BASELINE_REQUIRED, () => runDrift({ main: LANDED, plantOriginMain: false }));
  assert.equal(result.status, "skip");
  assert.match(result.details.join("\n"), /no origin\/main ref/);
  assert.match(result.details.join("\n"), /did NOT run/);
});

test("migration-drift: that skip becomes a failure when a baseline is required", () => {
  const result = withEnv({ GITHUB_ACTIONS: undefined, PREFLIGHT_REQUIRE_GIT_BASELINE: "1" }, () =>
    runDrift({ main: LANDED, plantOriginMain: false }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /a baseline is required here/);
});

// The condition that actually holds on every GitHub runner. Asserted on its
// own rather than left to the ambient environment, so this suite means the
// same thing wherever it runs.
test("migration-drift: GITHUB_ACTIONS alone is enough to require a baseline", () => {
  const result = withEnv({ GITHUB_ACTIONS: "true", PREFLIGHT_REQUIRE_GIT_BASELINE: undefined }, () =>
    runDrift({ main: LANDED, plantOriginMain: false }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /a baseline is required here/);
});

test("migration-drift: skips outside a git work tree rather than passing", () => {
  const result = withEnv(NO_BASELINE_REQUIRED, () =>
    runOne("migration-drift", {
      "apps/api/migrations/0001_init.sql": "CREATE TABLE a (id TEXT);\n",
    }),
  );
  assert.equal(result.status, "skip");
  assert.match(result.details.join("\n"), /not a git work tree/);
});

test("migration-drift: outside a git work tree, CI fails rather than skipping", () => {
  const result = withEnv({ GITHUB_ACTIONS: "true", PREFLIGHT_REQUIRE_GIT_BASELINE: undefined }, () =>
    runOne("migration-drift", {
      "apps/api/migrations/0001_init.sql": "CREATE TABLE a (id TEXT);\n",
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /a baseline is required here/);
});

// ── env-parity ─────────────────────────────────────────────────────────

const ENV_EXAMPLE_GOOD = `
MOD_TEXT_DAILY_BUDGET=1000
SITE_URL=http://localhost:8787

# secrets:
TURNSTILE_SECRET=
ADMIN_TOKEN=

EXPO_PUBLIC_SITE_URL=http://localhost:8081
`;

function wranglerToml({ dropPreviewVar = false, includeSecret = false } = {}) {
  return `
[vars]
MOD_TEXT_DAILY_BUDGET = "1000"
SITE_URL = "http://localhost:8787"
${includeSecret ? 'TURNSTILE_SECRET = "leaked"' : ""}

[env.preview]
name = "keepsake-preview"

[env.preview.vars]
MOD_TEXT_DAILY_BUDGET = "1000"
${dropPreviewVar ? "" : 'SITE_URL = "http://preview.example.com"'}

[env.production.vars]
MOD_TEXT_DAILY_BUDGET = "1000"
SITE_URL = "https://keepsake.ing"
`;
}

test("env-parity: passes when vars match across .env.example and every env block", () => {
  const result = runOne("env-parity", {
    ".env.example": ENV_EXAMPLE_GOOD,
    "apps/api/wrangler.toml": wranglerToml(),
  });
  assert.equal(result.status, "pass");
});

test("env-parity: fails when a var is missing from an env block", () => {
  const result = runOne("env-parity", {
    ".env.example": ENV_EXAMPLE_GOOD,
    "apps/api/wrangler.toml": wranglerToml({ dropPreviewVar: true }),
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /env\.preview\.vars/);
});

test("env-parity: fails when a secret leaks into wrangler [vars]", () => {
  const result = runOne("env-parity", {
    ".env.example": ENV_EXAMPLE_GOOD,
    "apps/api/wrangler.toml": wranglerToml({ includeSecret: true }),
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /TURNSTILE_SECRET/);
});

test("env-parity: skips when wrangler.toml is not present", () => {
  const result = runOne("env-parity", { ".env.example": ENV_EXAMPLE_GOOD });
  assert.equal(result.status, "skip");
});

test("parseEnvExample separates vars from secrets", () => {
  const { allNames, secretNames } = parseEnvExample(ENV_EXAMPLE_GOOD);
  assert.ok(allNames.includes("SITE_URL"));
  assert.ok(secretNames.has("TURNSTILE_SECRET"));
  assert.ok(!secretNames.has("SITE_URL"));
});

test("parseToml reads [vars] and [env.x.vars] but not [[array]] tables", () => {
  const toml = parseToml(wranglerToml());
  assert.equal(toml.vars.SITE_URL, "http://localhost:8787");
  assert.equal(toml["env.preview.vars"].SITE_URL, "http://preview.example.com");
});

// ── var-usage ──────────────────────────────────────────────────────────
//
// The check exists because `env-parity` above passes on a tree where the
// code and the config disagree — every fixture here starts from a good pair
// and breaks one thing, and the first test asserts the *other* check still
// passes on the broken tree, since "nothing else would have caught this" is
// the whole claim (#128).

const VAR_USAGE_ENV_EXAMPLE = `
REPORT_IP_DAILY_BUDGET=10
SHELF_MIN_ITEMS=3
SITE_URL=http://localhost:8787

# secrets:
ADMIN_TOKEN=
`;

// All three var blocks, like the real file — `env-parity` needs the named
// environments to have something to compare, and the point of the
// declared-nowhere fixture is that dropping a name from *every* copy leaves
// that check with nothing to notice.
function varUsageToml({ dropReport = false, extraVar = "" } = {}) {
  const vars = (site) => `
${dropReport ? "" : 'REPORT_IP_DAILY_BUDGET = "10"'}
SHELF_MIN_ITEMS = "3"
SITE_URL = "${site}"
${extraVar}`;
  return `
[vars]${vars("http://localhost:8787")}

[[kv_namespaces]]
binding = "KV"
id = "local"

[[ratelimits]]
name = "RL_REPORT"
namespace_id = "1006"

[env.preview.vars]${vars("https://preview.keepsake.ing")}

[env.production.vars]${vars("https://keepsake.ing")}
`;
}

// Mirrors the real shapes: a direct `env.X`, a `parseIntVar("X", …)` with a
// named fallback, a secret read the same way a var is, and — the one that
// makes this check necessary — a name that only ever reaches `env[…]`
// through a `…Var` union and its call site.
function varUsageSource({ fallback = "10", computedKey = "options.ipDailyLimitVar" } = {}) {
  return `
import { parseIntVar } from "./env.js";

export type IpDailyLimitVar = "REPORT_IP_DAILY_BUDGET";

const DEFAULT_REPORT_IP_DAILY_BUDGET = ${fallback};

export function siteUrl(env) {
  return env.SITE_URL;
}

export function admin(env) {
  return env.ADMIN_TOKEN;
}

export function shelfMinItems(env) {
  return parseIntVar("SHELF_MIN_ITEMS", env.SHELF_MIN_ITEMS, 3);
}

export function dailyBudget(options) {
  return (c) => parseIntVar(options.ipDailyLimitVar, c.env[${computedKey}], options.fallbackIpDailyLimit);
}

export const reportBudget = dailyBudget({
  ipDailyLimitVar: "REPORT_IP_DAILY_BUDGET",
  fallbackIpDailyLimit: DEFAULT_REPORT_IP_DAILY_BUDGET,
});
`;
}

function varUsageTree(overrides = {}) {
  return {
    ".env.example": VAR_USAGE_ENV_EXAMPLE,
    "apps/api/wrangler.toml": varUsageToml(),
    "apps/api/src/budgets.ts": varUsageSource(),
    ...overrides,
  };
}

test("var-usage: passes when every var is declared, read and matched by its fallback", () => {
  const result = runOne("var-usage", varUsageTree());
  assert.equal(result.status, "pass");
  // The indirect name is the point: REPORT_IP_DAILY_BUDGET appears as
  // `env.X` nowhere in the fixture, only in the union and the call site.
  assert.match(result.details.join("\n"), /3 var\(s\)/);
});

test("var-usage: fails when a var the code reads is declared in no [vars] block", () => {
  const files = varUsageTree({ "apps/api/wrangler.toml": varUsageToml({ dropReport: true }) });
  files[".env.example"] = VAR_USAGE_ENV_EXAMPLE.replace("REPORT_IP_DAILY_BUDGET=10\n", "");
  const result = runOne("var-usage", files);
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /REPORT_IP_DAILY_BUDGET: read at/);

  // The reason this check has to exist: with the name gone from all four
  // copies of the list, env-parity is perfectly happy.
  assert.equal(runOne("env-parity", files).status, "pass");
});

test("var-usage: fails when a declared var is read nowhere (the MAX_PHOTOS shape)", () => {
  const result = runOne("var-usage", {
    ...varUsageTree({ "apps/api/wrangler.toml": varUsageToml({ extraVar: 'IMAGE_TRANSFORMS_ENABLED = "1"' }) }),
    ".env.example": `${VAR_USAGE_ENV_EXAMPLE}\nIMAGE_TRANSFORMS_ENABLED=1\n`,
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /IMAGE_TRANSFORMS_ENABLED: declared in .* but read nowhere/);
});

test("var-usage: a var named only in a comment is not a read", () => {
  const result = runOne("var-usage", {
    ...varUsageTree({ "apps/api/wrangler.toml": varUsageToml({ extraVar: 'IMAGE_TRANSFORMS_ENABLED = "1"' }) }),
    ".env.example": `${VAR_USAGE_ENV_EXAMPLE}\nIMAGE_TRANSFORMS_ENABLED=1\n`,
    "apps/api/src/notes.ts": "// env.IMAGE_TRANSFORMS_ENABLED is described here and read by nothing.\nexport const x = 1;\n",
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /IMAGE_TRANSFORMS_ENABLED: declared in .* but read nowhere/);
});

test("var-usage: fails when a code fallback disagrees with the declared value", () => {
  const result = runOne("var-usage", varUsageTree({ "apps/api/src/budgets.ts": varUsageSource({ fallback: "5" }) }));
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /REPORT_IP_DAILY_BUDGET: .*declares 10 but .* falls back to 5/);
});

test("var-usage: fails on a computed env[...] whose key it cannot resolve", () => {
  const result = runOne("var-usage", varUsageTree({ "apps/api/src/budgets.ts": varUsageSource({ computedKey: "key" }) }));
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /computed env\[key\]/);
});

test("var-usage: a computed env[...] naming a binding is not a var read", () => {
  const result = runOne("var-usage", {
    ...varUsageTree(),
    "apps/api/src/burst.ts": "export function burst(c, bindingName) {\n  return c.env[bindingName];\n}\n",
  });
  assert.equal(result.status, "pass");
});

test("var-usage: skips when wrangler.toml is not present", () => {
  const result = runOne("var-usage", { "apps/api/src/budgets.ts": varUsageSource() });
  assert.equal(result.status, "skip");
});

test("resolveNumericExpr reads literals, products and identifier chains", () => {
  const globals = new Map([["DEFAULT_MAX", "OTHER"], ["OTHER", "5 * 1024 * 1024"], ["LOOP", "LOOP"]]);
  assert.equal(resolveNumericExpr("10", null, globals), 10);
  assert.equal(resolveNumericExpr("5 * 1024 * 1024", null, globals), 5242880);
  assert.equal(resolveNumericExpr("DEFAULT_MAX", null, globals), 5242880);
  assert.equal(resolveNumericExpr("options.fallbackIpDailyLimit", null, globals), undefined);
  assert.equal(resolveNumericExpr("LOOP", null, globals), undefined);
});

test("callArguments splits a call written across lines", () => {
  const text = 'parseIntVar(\n  "SHELF_MIN_ITEMS",\n  env.SHELF_MIN_ITEMS as string | undefined,\n  DEFAULT_SHELF,\n)';
  const args = callArguments(text, text.indexOf("("));
  assert.deepEqual(args, ['"SHELF_MIN_ITEMS"', "env.SHELF_MIN_ITEMS as string | undefined", "DEFAULT_SHELF", ""]);
});

// ── backup-tables ──────────────────────────────────────────────────────
//
// #164: the documented `--table` list omitted `listing_aspects`, so no export
// made by following restore.md contained any listing's aspects — and
// `listings.aspects_backfilled_at`, which *is* in the export, made the loss
// permanent. The list going stale once is a typo; twice is a missing guard.

const BACKUP_MIGRATIONS = {
  "apps/api/migrations/0001_init.sql": "CREATE TABLE owners (id TEXT PRIMARY KEY);\nCREATE TABLE listings (id TEXT PRIMARY KEY);\n",
  "apps/api/migrations/0002_geo.sql": "CREATE TABLE postal_codes (code TEXT PRIMARY KEY);\n",
  "apps/api/migrations/0003_fts.sql": "CREATE VIRTUAL TABLE listings_fts USING fts5(title, content='listings');\n",
};

function backupRunbook(tables) {
  return `# Restore

\`\`\`sh
pnpm exec wrangler d1 export keepsake-db-production --no-schema \\
${tables.map((t) => `  --table ${t}`).join(" \\\n")}
\`\`\`

\`postal_codes\` is excluded: it is reproducible from the bundled seed.
`;
}

test("backup-tables: passes when the documented list covers every migration-created table", () => {
  const result = runOne("backup-tables", {
    ...BACKUP_MIGRATIONS,
    "docs/runbooks/restore.md": backupRunbook(["owners", "listings"]),
  });
  assert.equal(result.status, "pass", result.details.join("\n"));
  assert.match(result.details[0], /excluding postal_codes \(documented\)/);
  assert.match(result.details[0], /listings_fts is virtual/);
});

test("backup-tables: fails when a later migration adds a table the runbook never learned about", () => {
  // This is #164 itself, and the break-the-guard experiment the issue asks
  // for: a new migration, a new table, an unchanged runbook.
  const result = runOne("backup-tables", {
    ...BACKUP_MIGRATIONS,
    "apps/api/migrations/0006_aspects.sql": "CREATE TABLE listing_aspects (listing_id TEXT, aspect TEXT);\n",
    "docs/runbooks/restore.md": backupRunbook(["owners", "listings"]),
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /creates "listing_aspects" but docs\/runbooks\/restore\.md's export command does not `--table` it/);
});

test("backup-tables: fails when a table is excluded with no written reason", () => {
  const result = runOne("backup-tables", {
    ...BACKUP_MIGRATIONS,
    "docs/runbooks/restore.md": backupRunbook(["owners", "listings"]).replace(
      /`postal_codes` is excluded.*\n/,
      "",
    ),
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /excluded from the documented export but .* never mentions it/);
});

test("backup-tables: fails when the runbook names a table no migration creates", () => {
  const result = runOne("backup-tables", {
    ...BACKUP_MIGRATIONS,
    "docs/runbooks/restore.md": backupRunbook(["owners", "listings", "wishlists"]),
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /--table wishlists names a table no migration/);
});

test("backup-tables: fails when the runbook tries to export the FTS5 virtual table", () => {
  const result = runOne("backup-tables", {
    ...BACKUP_MIGRATIONS,
    "docs/runbooks/restore.md": backupRunbook(["owners", "listings", "listings_fts"]),
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /listings_fts is an FTS5 virtual table/);
});

test("backup-tables: fails rather than passing when the runbook has no --table list at all", () => {
  const result = runOne("backup-tables", {
    ...BACKUP_MIGRATIONS,
    "docs/runbooks/restore.md": "# Restore\n\nJust use Time Travel.\n",
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /contains no `--table` arguments/);
});

test("backup-tables: this repository's own runbook covers listing_aspects", () => {
  const result = runChecks(["backup-tables"], REPO_ROOT)[0];
  assert.equal(result.status, "pass", result.details.join("\n"));
  const runbook = createContext(REPO_ROOT).readText("docs/runbooks/restore.md");
  assert.match(runbook, /--table listing_aspects/, "#164's actual fix");
});

test("tablesAfterMigrations replays rename/create/drop rather than counting CREATEs", () => {
  // 0005_compliance.sql's shuffle: rename the old table aside, create the new
  // one, copy, drop the old. Naively counting CREATE TABLE sees two.
  const { real, virtual } = tablesAfterMigrations([
    "CREATE TABLE requests (id TEXT);",
    `ALTER TABLE requests RENAME TO requests_old;
     CREATE TABLE requests (id TEXT, note TEXT);
     INSERT INTO requests SELECT id, NULL FROM requests_old;
     DROP TABLE requests_old;`,
    "CREATE VIRTUAL TABLE listings_fts USING fts5(title);",
  ]);
  assert.deepEqual([...real].sort(), ["requests"]);
  assert.deepEqual([...virtual], ["listings_fts"]);
});

test("documentedBackupTables reads the --table arguments out of the runbook", () => {
  assert.deepEqual(documentedBackupTables("  --table owners --table listings \\\n  --table photos\n"), [
    "owners",
    "listings",
    "photos",
  ]);
});

// ── cron-triggers ──────────────────────────────────────────────────────
//
// `scheduled()` dispatches on the literal cron string, so the two halves —
// `wrangler.toml`'s list and the switch in `apps/api/src/index.ts` — have to
// agree exactly. Every fixture below starts from a good pair and breaks one
// thing, because a check that has only ever seen a matching pair cannot tell
// you it would notice a mismatched one.

const SCHEDULED_GOOD = `
async function scheduled(controller, env, ctx) {
  switch (controller.cron) {
    case "*/5 * * * *":
      await runCron("moderationRetry", moderationRetry, env, ctx);
      break;
    case "17 3 * * *":
      await runCron("orphanSweep", orphanSweep, env, ctx);
      break;
    default:
      console.warn("scheduled: unrecognized cron pattern", { cron: controller.cron });
  }
}
export default { fetch: app.fetch, scheduled };
`;

function cronToml({ topCrons = '["*/5 * * * *", "17 3 * * *"]', productionTriggers = "" } = {}) {
  return `
main = "src/index.ts"

# a comment mentioning crons = ["never parsed"] must not count
[triggers]
crons = ${topCrons}

[vars]
ENVIRONMENT = "development"

[[send_email]]
name = "EMAIL"

[env.preview.vars]
ENVIRONMENT = "preview"

[env.production.vars]
ENVIRONMENT = "production"
${productionTriggers}
`;
}

function cronTree(overrides = {}) {
  return {
    "apps/api/wrangler.toml": cronToml(),
    "apps/api/src/index.ts": SCHEDULED_GOOD,
    ...overrides,
  };
}

test("cron-triggers: passes when every tier inherits a valid, handled cron list", () => {
  const result = runOne("cron-triggers", cronTree());
  assert.equal(result.status, "pass");
  // The inheritance this repo relies on, stated in the passing output so the
  // next reader does not have to re-derive it from wrangler's source.
  assert.match(result.details.join("\n"), /inherited by preview, production/);
});

test("cron-triggers: passes when a tier restates its own non-empty list", () => {
  const result = runOne(
    "cron-triggers",
    cronTree({
      "apps/api/wrangler.toml": cronToml({
        productionTriggers: '\n[env.production.triggers]\ncrons = ["*/5 * * * *", "17 3 * * *"]\n',
      }),
    }),
  );
  assert.equal(result.status, "pass");
});

// The failure mode that made this check worth writing: an env block that
// restates `[triggers]` as an empty list silently switches that tier's crons
// off, and no other check in this repo would notice.
test("cron-triggers: fails when an env block overrides the inherited list with []", () => {
  const result = runOne(
    "cron-triggers",
    cronTree({
      "apps/api/wrangler.toml": cronToml({
        productionTriggers: "\n[env.production.triggers]\ncrons = []\n",
      }),
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /env\.production: crons = \[\]/);
  assert.match(result.details.join("\n"), /no scheduled jobs at all/);
});

test("cron-triggers: fails when no tier resolves any cron at all", () => {
  const result = runOne(
    "cron-triggers",
    cronTree({
      "apps/api/wrangler.toml": cronToml({ topCrons: "[]" }),
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /no scheduled jobs are registered anywhere/);
});

test("cron-triggers: fails on a schedule that is not a valid cron expression", () => {
  const result = runOne(
    "cron-triggers",
    cronTree({
      "apps/api/wrangler.toml": cronToml({ topCrons: '["*/5 * * * *", "17 25 * * *"]' }),
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /hour "25" is outside 0-23/);
});

// Editing the schedule in one place and not the other leaves the job
// registered with Cloudflare, firing on time, and doing nothing.
test("cron-triggers: fails when a declared cron has no case in scheduled()", () => {
  const result = runOne(
    "cron-triggers",
    cronTree({
      "apps/api/wrangler.toml": cronToml({ topCrons: '["*/5 * * * *", "17 4 * * *"]' }),
    }),
  );
  assert.equal(result.status, "fail");
  const text = result.details.join("\n");
  assert.match(text, /cron "17 4 \* \* \*" is declared in apps\/api\/wrangler\.toml but no case/);
  assert.match(text, /fall through to default:/);
  // And the other direction, from the same edit: the handled case is orphaned.
  assert.match(text, /scheduled\(\) handles "17 3 \* \* \*", which apps\/api\/wrangler\.toml does not declare/);
});

test("cron-triggers: fails when crons are declared but there is no scheduled() handler", () => {
  const result = runOne(
    "cron-triggers",
    cronTree({ "apps/api/src/index.ts": "export default { fetch: app.fetch };\n" }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /no scheduled\(\) handler/);
});

test("cron-triggers: fails when scheduled() handles crons nothing declares", () => {
  const result = runOne("cron-triggers", {
    "apps/api/wrangler.toml": '[vars]\nENVIRONMENT = "development"\n',
    "apps/api/src/index.ts": SCHEDULED_GOOD,
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /declares no \[triggers\] crons — nothing will ever invoke it/);
});

test("cron-triggers: skips when wrangler.toml is not present", () => {
  const result = runOne("cron-triggers", { "apps/api/src/index.ts": SCHEDULED_GOOD });
  assert.equal(result.status, "skip");
});

// ── cron-triggers, the third file (#176) ───────────────────────────────
//
// `cron/registry.ts` is where a job's name, schedule and staleness threshold
// are described together, and it is what `/api/admin/health` and the daily
// digest read. The check used to open two of the three files while two
// documents said it tied all three together.

const REGISTRY_GOOD = `
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export const CRON_JOBS = [
  {
    name: "moderationRetry",
    cron: "*/5 * * * *",
    staleAfterMs: 30 * MINUTE,
  },
  {
    name: "orphanSweep",
    cron: "17 3 * * *",
    staleAfterMs: 26 * HOUR,
  },
] as const satisfies readonly CronJobSpec[];
`;

test("cron-triggers: passes and says so when the registry agrees with both other files", () => {
  const result = runOne("cron-triggers", cronTree({ "apps/api/src/cron/registry.ts": REGISTRY_GOOD }));
  assert.equal(result.status, "pass", result.details.join("\n"));
  assert.match(result.details.join("\n"), /2 apps\/api\/src\/cron\/registry\.ts job\(s\) agree/);
  assert.match(result.details.join("\n"), /moderationRetry \("\*\/5 \* \* \* \*", stale after 30m\)/);
});

test("cron-triggers: says out loud when there is no registry to check, rather than implying it agreed", () => {
  const result = runOne("cron-triggers", cronTree());
  assert.equal(result.status, "pass");
  assert.match(result.details.join("\n"), /registry\.ts not present, so registry agreement was not checked/);
});

test("cron-triggers: fails when a registry job's schedule is declared nowhere (#176's own experiment)", () => {
  const result = runOne(
    "cron-triggers",
    cronTree({
      "apps/api/src/cron/registry.ts": REGISTRY_GOOD.replace('cron: "17 3 * * *"', 'cron: "0 0 * * 0"'),
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /"orphanSweep" is scheduled "0 0 \* \* 0", which env\.production does not declare/);
});

test("cron-triggers: fails when the registry name is not the string runCron is handed", () => {
  const result = runOne(
    "cron-triggers",
    cronTree({
      "apps/api/src/cron/registry.ts": REGISTRY_GOOD.replace('name: "orphanSweep"', 'name: "nightlySweep"'),
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(
    result.details.join("\n"),
    /scheduled\(\) runs "orphanSweep" for cron "17 3 \* \* \*", but .*registry\.ts calls that job "nightlySweep"/,
  );
  assert.match(result.details.join("\n"), /heartbeat key \(cron:last:<name>\)/);
});

test("cron-triggers: fails when a declared, dispatched cron has no registry entry watching it", () => {
  const result = runOne(
    "cron-triggers",
    cronTree({
      "apps/api/src/cron/registry.ts": REGISTRY_GOOD.replace(
        /\{\s*name: "orphanSweep"[\s\S]*?\},\n/,
        "",
      ),
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /no CRON_JOBS entry .* describes it/);
});

test("cron-triggers: fails when staleAfterMs does not exceed the schedule's own interval", () => {
  const result = runOne(
    "cron-triggers",
    cronTree({
      // Five-minute job, five-minute threshold: every healthy run is "stale".
      "apps/api/src/cron/registry.ts": REGISTRY_GOOD.replace("staleAfterMs: 30 * MINUTE", "staleAfterMs: 5 * MINUTE"),
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /"moderationRetry" fires every 5m .* but staleAfterMs is 5m/);
});

test("cron-triggers: fails when staleAfterMs cannot be resolved to a number", () => {
  const result = runOne(
    "cron-triggers",
    cronTree({
      "apps/api/src/cron/registry.ts": REGISTRY_GOOD.replace("staleAfterMs: 26 * HOUR", "staleAfterMs: config.sweepStale"),
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /cannot resolve to a number — an unreadable threshold is an unchecked one/);
});

test("cron-triggers: fails when registry.ts is present but CRON_JOBS cannot be parsed", () => {
  const result = runOne(
    "cron-triggers",
    cronTree({ "apps/api/src/cron/registry.ts": "export const JOBS = [];\n" }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /no CRON_JOBS entries could be parsed/);
});

test("cron-triggers: reads this repository's real registry, and all three files agree today", () => {
  const result = runChecks(["cron-triggers"], REPO_ROOT)[0];
  assert.equal(result.status, "pass", result.details.join("\n"));
  const text = result.details.join("\n");
  for (const name of ["moderationRetry", "orphanSweep", "dailyDigest"]) {
    assert.match(text, new RegExp(name), `the real registry job ${name} was not reported as checked`);
  }
});

test("parseCronRegistry resolves MINUTE/HOUR products and ignores commented-out entries", () => {
  const jobs = parseCronRegistry(REGISTRY_GOOD);
  assert.deepEqual(
    jobs.map((j) => [j.name, j.cron, j.staleAfterMs]),
    [
      ["moderationRetry", "*/5 * * * *", 30 * 60 * 1000],
      ["orphanSweep", "17 3 * * *", 26 * 60 * 60 * 1000],
    ],
  );
  assert.equal(parseCronRegistry("export const NOTHING = 1;\n"), null);
});

test("cronIntervalMs returns the longest gap between firings", () => {
  assert.equal(cronIntervalMs("*/5 * * * *"), 5 * 60 * 1000);
  assert.equal(cronIntervalMs("17 3 * * *"), 24 * 60 * 60 * 1000);
  assert.equal(cronIntervalMs("7 0 * * *"), 24 * 60 * 60 * 1000);
  assert.equal(cronIntervalMs("0 0 * * 0"), 7 * 24 * 60 * 60 * 1000);
  // Weekdays only: the Friday→Monday gap is the one a threshold has to beat.
  assert.equal(cronIntervalMs("0 9 * * 1-5"), 3 * 24 * 60 * 60 * 1000);
  // Longer than a week: not computed, and the caller says so rather than
  // treating "not computed" as "fine".
  assert.equal(cronIntervalMs("0 0 1 * *"), null);
});

test("scheduledCronDispatch pairs each case with the name it hands runCron", () => {
  assert.deepEqual(scheduledCronDispatch(SCHEDULED_GOOD), [
    { cron: "*/5 * * * *", jobName: "moderationRetry" },
    { cron: "17 3 * * *", jobName: "orphanSweep" },
  ]);
  assert.equal(scheduledCronDispatch("export default { fetch };\n"), null);
});

test("parseCronTriggers reads top-level, per-env, multi-line and empty lists", () => {
  const sections = parseCronTriggers(`
[triggers]
crons = [
  "*/5 * * * *",
  "17 3 * * *",
]

[[ratelimits]]
name = "RL_READ"

[env.preview.triggers]
crons = []

[env.production.vars]
# crons = ["not a real declaration"]
ENVIRONMENT = "production"
`);
  assert.deepEqual(sections.triggers, ["*/5 * * * *", "17 3 * * *"]);
  // Present and empty is not the same as absent — that distinction is the
  // whole point of the override check above.
  assert.deepEqual(sections["env.preview.triggers"], []);
  assert.ok(!Object.hasOwn(sections, "env.production.triggers"));
});

test("cronExpressionProblem accepts real schedules and names bad ones", () => {
  assert.equal(cronExpressionProblem("*/5 * * * *"), null);
  assert.equal(cronExpressionProblem("17 3 * * *"), null);
  assert.equal(cronExpressionProblem("0 0 1 JAN MON"), null);
  assert.equal(cronExpressionProblem("30 4 * * 0-6"), null);
  assert.match(cronExpressionProblem("17 3 * *"), /has 4 field\(s\), not 5/);
  assert.match(cronExpressionProblem("60 3 * * *"), /minute "60" is outside 0-59/);
  assert.match(cronExpressionProblem("*/0 3 * * *"), /step "0"/);
  assert.match(cronExpressionProblem("17 3 * FOO *"), /month "FOO" is not a number or name/);
  assert.match(cronExpressionProblem("17 9-3 * * *"), /reversed range/);
});

test("scheduledCronCases reads only the switch inside scheduled()", () => {
  assert.deepEqual(scheduledCronCases(SCHEDULED_GOOD), ["*/5 * * * *", "17 3 * * *"]);
  assert.equal(scheduledCronCases("export default { fetch: app.fetch };\n"), null);
});

// ── models ─────────────────────────────────────────────────────────────

test("models: passes when @cf/ appears only in models.ts", () => {
  const result = runOne("models", {
    "apps/api/src/models.ts": 'export const textGuard = "@cf/meta/llama-guard-3-8b";\n',
    "apps/api/src/routes/listings.ts": "export const ok = true;\n",
  });
  assert.equal(result.status, "pass");
});

test("models: fails when @cf/ leaks into another file", () => {
  const result = runOne("models", {
    "apps/api/src/models.ts": 'export const textGuard = "@cf/meta/llama-guard-3-8b";\n',
    "apps/api/src/moderation/pipeline.ts": 'const model = "@cf/meta/llama-guard-3-8b";\n',
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /pipeline\.ts/);
});

test("models: ignores test files", () => {
  const result = runOne("models", {
    "apps/api/src/models.ts": 'export const textGuard = "@cf/meta/llama-guard-3-8b";\n',
    "apps/api/src/moderation/pipeline.test.ts": 'const model = "@cf/meta/llama-guard-3-8b";\n',
  });
  assert.equal(result.status, "pass");
});

// ── verify-email-token ─────────────────────────────────────────────────

// The two mint shapes the real tree has, reduced to what the check reads.
const VERIFY_MINT_GOOD = [
  "await c.env.DB.prepare(",
  "  `INSERT INTO recovery_tokens (id, owner_id, purpose, email, token_hash, expires_at, created_at)",
  "   VALUES (?, ?, 'verify_email', ?, ?, ?, ?)`,",
  ")",
  "  .bind(ulid(), owner.id, input.email, tokenHash, now + TTL, now)",
  "  .run();",
  "",
].join("\n");

const RECOVER_MINT = [
  "await c.env.DB.prepare(",
  "  `INSERT INTO recovery_tokens (id, owner_id, purpose, token_hash, expires_at, created_at)",
  "   VALUES (?, ?, 'recover', ?, ?, ?)`,",
  ")",
  "  .bind(ulid(), owner.id, tokenHash, now + TTL, now)",
  "  .run();",
  "",
].join("\n");

test("verify-email-token: passes when every verify_email mint site records the address", () => {
  const result = runOne("verify-email-token", {
    "apps/api/src/routes/me.ts": VERIFY_MINT_GOOD,
    "apps/api/src/routes/listings.ts": VERIFY_MINT_GOOD,
    "apps/api/src/routes/recover.ts": RECOVER_MINT,
  });
  assert.equal(result.status, "pass");
});

test("verify-email-token: fails on a verify_email mint site with no email column (the #202 bug)", () => {
  const result = runOne("verify-email-token", {
    "apps/api/src/routes/me.ts": VERIFY_MINT_GOOD,
    // Exactly what apps/api/src/routes/listings.ts wrote before #202.
    "apps/api/src/routes/listings.ts": VERIFY_MINT_GOOD.replace("purpose, email,", "purpose,").replace("'verify_email', ?, ?, ?, ?", "'verify_email', ?, ?, ?"),
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /listings\.ts:2: INSERT INTO recovery_tokens mints a verify_email token that does not record/);
});

test("verify-email-token: fails on a mint site that binds purpose at runtime and skips the address", () => {
  // The dodge a "verify_email inserts must name email" rule would miss: no
  // literal to match on, so the check demands the column from every insert
  // that does not name a non-verify purpose inline.
  const result = runOne("verify-email-token", {
    "apps/api/src/routes/me.ts": [
      "await c.env.DB.prepare(",
      "  `INSERT INTO recovery_tokens (id, owner_id, purpose, token_hash, expires_at, created_at)",
      "   VALUES (?, ?, ?, ?, ?, ?)`,",
      ")",
      "  .bind(ulid(), owner.id, purpose, tokenHash, now + TTL, now)",
      "  .run();",
      "",
    ].join("\n"),
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /binds purpose at runtime and does not record/);
});

test("verify-email-token: a recover token needs no address", () => {
  const result = runOne("verify-email-token", { "apps/api/src/routes/recover.ts": RECOVER_MINT });
  assert.equal(result.status, "pass");
  assert.match(result.details.join("\n"), /recover — no address needed/);
});

test("verify-email-token: fails against a tree with no mint site at all", () => {
  // #166's lesson: a check whose only evidence is a fixture it invented can
  // skip every real run and still look green. Finding nothing to examine is
  // a failure here, not a pass.
  const result = runOne("verify-email-token", { "apps/api/src/routes/feed.ts": "export const feedRoutes = new Hono();\n" });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /no INSERT INTO recovery_tokens found/);
});

test("verify-email-token: the repository's own mint sites all record the address", () => {
  // The fixtures above prove the logic; this runs it against the bytes that
  // actually ship, which is the half #166 found missing.
  const result = runChecks(["verify-email-token"], REPO_ROOT)[0];
  assert.equal(result.status, "pass", result.details.join("\n"));
  assert.match(result.details.join("\n"), /routes\/listings\.ts:\d+: verify_email — records the address/);
  assert.match(result.details.join("\n"), /routes\/me\.ts:\d+: verify_email — records the address/);
});

// ── ip-digest ──────────────────────────────────────────────────────────

// The helper the real `apps/api/src/lib/digest.ts` exports, reduced to what
// the check reads: an exported `dailyIpDigest` whose body includes the day.
const DIGEST_GOOD = [
  'import { todayISO } from "./day.js";',
  "export async function sha256Hex(input: string): Promise<string> {",
  '  return input;',
  "}",
  "export async function dailyIpDigest(clientIP: string): Promise<string> {",
  "  return sha256Hex(`${todayISO()}:${clientIP}`);",
  "}",
  "",
].join("\n");

test("ip-digest: passes when every IP digest goes through dailyIpDigest", () => {
  const result = runOne("ip-digest", {
    "apps/api/src/lib/digest.ts": DIGEST_GOOD,
    "apps/api/src/middleware/rateLimit.ts": "const key = await dailyIpDigest(clientIPFrom(c.req.raw));\n",
    "apps/api/src/routes/recover.ts": "const tokenHash = await sha256Hex(rawToken);\n",
  });
  assert.equal(result.status, "pass");
});

test("ip-digest: fails on a bare sha256Hex of the caller's address (the #87 bug)", () => {
  const result = runOne("ip-digest", {
    "apps/api/src/lib/digest.ts": DIGEST_GOOD,
    "apps/api/src/middleware/rateLimit.ts": "const key = await sha256Hex(clientIPFrom(c.req.raw));\n",
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /rateLimit\.ts:1: hashes a client IP without the day/);
});

test("ip-digest: fails on a hand-rolled day-salted digest that bypasses the helper", () => {
  const result = runOne("ip-digest", {
    "apps/api/src/lib/digest.ts": DIGEST_GOOD,
    "apps/api/src/routes/listings.ts": "const ipDigest = await sha256Hex(`${todayISO()}:${clientIP}`);\n",
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /listings\.ts:1: hashes a client IP/);
});

test("ip-digest: fails on sha256Hex(ip) — the two-statement dodge with a telling name", () => {
  const result = runOne("ip-digest", {
    "apps/api/src/lib/digest.ts": DIGEST_GOOD,
    "apps/api/src/middleware/rateLimit.ts": "const ip = clientIPFrom(c.req.raw);\nconst key = await sha256Hex(ip);\n",
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /rateLimit\.ts:2: hashes a client IP/);
});

test("ip-digest: fails on crypto.subtle.digest outside lib/digest.ts", () => {
  const result = runOne("ip-digest", {
    "apps/api/src/lib/digest.ts": DIGEST_GOOD,
    "apps/api/src/moderation/budget.ts": 'const d = await crypto.subtle.digest("SHA-256", input);\n',
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /budget\.ts:1: crypto\.subtle\.digest\(\) outside/);
});

test("ip-digest: fails when the helper itself stops including the day", () => {
  const result = runOne("ip-digest", {
    "apps/api/src/lib/digest.ts": DIGEST_GOOD.replace("`${todayISO()}:${clientIP}`", "clientIP"),
    "apps/api/src/middleware/rateLimit.ts": "const key = await dailyIpDigest(clientIPFrom(c.req.raw));\n",
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /does not include todayISO\(\)/);
});

test("ip-digest: ignores test files", () => {
  const result = runOne("ip-digest", {
    "apps/api/src/lib/digest.ts": DIGEST_GOOD,
    "apps/api/src/middleware/rateLimit.test.ts": "const key = await sha256Hex(clientIPFrom(req));\n",
  });
  assert.equal(result.status, "pass");
});

// ── exports ────────────────────────────────────────────────────────────

test("exports: passes for subpath-only exports whose targets exist", () => {
  const result = runOne("exports", {
    "packages/tokens/package.json": JSON.stringify({
      name: "@keepsake/tokens",
      exports: { "./colors": "./src/colors.ts" },
    }),
    "packages/tokens/src/colors.ts": "export const x = 1;\n",
  });
  assert.equal(result.status, "pass");
});

test("exports: fails on a \".\" barrel entry", () => {
  const result = runOne("exports", {
    "packages/tokens/package.json": JSON.stringify({
      name: "@keepsake/tokens",
      exports: { ".": "./src/index.ts", "./colors": "./src/colors.ts" },
    }),
    "packages/tokens/src/index.ts": "export {};\n",
    "packages/tokens/src/colors.ts": "export const x = 1;\n",
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /barrel/);
});

test("exports: fails when a subpath target does not exist", () => {
  const result = runOne("exports", {
    "packages/tokens/package.json": JSON.stringify({
      name: "@keepsake/tokens",
      exports: { "./colors": "./src/colors.ts" },
    }),
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /colors\.ts/);
});

// ── routes ─────────────────────────────────────────────────────────────

test("routes: passes when every route file exports default", () => {
  const result = runOne("routes", {
    "apps/web/app/index.tsx": "export default function Feed() { return null; }\n",
    "apps/web/app/_layout.tsx": "export default function Layout() { return null; }\n",
    "apps/web/app/+html.tsx": "export default function Html() { return null; }\n",
  });
  assert.equal(result.status, "pass");
});

test("routes: fails when a route is missing export default", () => {
  const result = runOne("routes", {
    "apps/web/app/index.tsx": "export function Feed() { return null; }\n",
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /index\.tsx/);
});

test("routes: _layout.tsx must also export default", () => {
  const result = runOne("routes", {
    "apps/web/app/_layout.tsx": "export function Layout() { return null; }\n",
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /_layout\.tsx/);
});

test("routes: a non-html/not-found + file is excluded from the check", () => {
  const result = runOne("routes", {
    "apps/web/app/+native-intent.tsx": "export function redirectSystemPath() { return '/'; }\n",
  });
  // The directory exists and was scanned; the file just isn't one that has
  // to export a route component, so there is nothing to fail.
  assert.equal(result.status, "pass");
});

// ── conflict-markers ───────────────────────────────────────────────────

test("conflict-markers: passes on clean tracked text", () => {
  const result = runOne("conflict-markers", {
    "README.md": "# Keepsake\n\nHello.\n",
  });
  assert.equal(result.status, "pass");
});

test("conflict-markers: fails on a leftover marker", () => {
  const result = runOne("conflict-markers", {
    "README.md": "# Keepsake\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n",
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /README\.md/);
});

// ── lfs-pointers ───────────────────────────────────────────────────────

test("lfs-pointers: passes on a real seed file", () => {
  const result = runOne("lfs-pointers", {
    "apps/api/seeds/postal_codes.sql": "INSERT INTO postal_codes VALUES (1);\n",
  });
  assert.equal(result.status, "pass");
});

test("lfs-pointers: fails on an unfetched LFS pointer", () => {
  const result = runOne("lfs-pointers", {
    "apps/api/seeds/postal_codes.sql":
      "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123\n",
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /git lfs pull/);
});

// The same pointer means two different things, and the message has to say
// which. `lfsInstalled` is passed explicitly rather than detected, so these
// two assert both branches wherever they run — a GitHub runner has git-lfs
// and an agent container does not, and a test that read the ambient answer
// would only ever exercise one of them.
const POINTER_TREE = {
  "apps/api/seeds/postal_codes.sql":
    "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 123\n",
};

function runLfs(files, lfsInstalled) {
  const root = makeTree(files);
  try {
    return checkLfsPointers(createContext(root), lfsInstalled);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("lfs-pointers: a pointer with no git-lfs installed says the repo is fine, this box is not", () => {
  const result = runLfs(POINTER_TREE, false);
  assert.equal(result.status, "fail");
  const text = result.details.join("\n");
  assert.match(text, /git-lfs is NOT installed here/);
  assert.match(text, /the file in the repository is fine/);
  assert.match(text, /Install git-lfs first, then run: git lfs install && git lfs pull/);
});

test("lfs-pointers: a pointer WITH git-lfs installed is a real unfetched object, and still fails", () => {
  const result = runLfs(POINTER_TREE, true);
  assert.equal(result.status, "fail");
  const text = result.details.join("\n");
  assert.match(text, /git-lfs IS installed here, so the object was never pulled/);
  assert.match(text, /Run: git lfs install && git lfs pull/);
  // Never a skip or a warn: in CI (`lfs: true`) a pointer here is a real bug.
  assert.notEqual(result.status, "skip");
});

test("lfs-pointers: a real seed passes whether or not git-lfs is installed", () => {
  const good = { "apps/api/seeds/postal_codes.sql": "INSERT INTO postal_codes VALUES (1);\n" };
  assert.equal(runLfs(good, false).status, "pass");
  assert.equal(runLfs(good, true).status, "pass");
});

test("lfsPointerDetail: the two messages are different and each names its own cause", () => {
  const missing = lfsPointerDetail("apps/api/seeds/x.sql", false);
  const present = lfsPointerDetail("apps/api/seeds/x.sql", true);
  assert.notEqual(missing, present);
  assert.match(missing, /`git lfs version` fails/);
  assert.match(present, /skipped smudge filter/);
});

// ── public-env ─────────────────────────────────────────────────────────

test("public-env: passes for an allowlisted TOKEN/KEY name", () => {
  const result = runOne("public-env", {
    "apps/web/app/give/review.tsx": 'const key = process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY;\n',
  });
  assert.equal(result.status, "pass");
});

test("public-env: fails on EXPO_PUBLIC_API_SECRET", () => {
  const result = runOne("public-env", {
    "apps/web/app/give/review.tsx": 'const secret = process.env.EXPO_PUBLIC_API_SECRET;\n',
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /EXPO_PUBLIC_API_SECRET/);
});

test("public-env: fails on a non-allowlisted TOKEN name", () => {
  const result = runOne("public-env", {
    "apps/web/app/give/review.tsx": 'const t = process.env.EXPO_PUBLIC_SOME_TOKEN;\n',
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /EXPO_PUBLIC_SOME_TOKEN/);
});

test("public-env: skips when nothing is present to scan", () => {
  const result = runOne("public-env", {});
  assert.equal(result.status, "skip");
});

// ── public-env-passthrough ─────────────────────────────────────────────
//
// #175: `.env.example` declared seven EXPO_PUBLIC_* names and deploy.yml
// passed four, and nothing reconciled the two lists — `env-parity` excludes
// EXPO_PUBLIC_* on purpose, and verify-public-env.mjs derived its
// expectations from the very environment that was missing the variable.

const DEPLOY_WORKFLOW = `name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Export web
        env:
          EXPO_PUBLIC_SITE_URL: \${{ vars.EXPO_PUBLIC_SITE_URL }}
          EXPO_PUBLIC_ENV: \${{ env.DEPLOY_ENV }}
        run: pnpm --filter @keepsake/web export
`;

test("public-env-passthrough: passes when the two lists agree", () => {
  const result = runOne("public-env-passthrough", {
    ".env.example": "ENVIRONMENT=development\nEXPO_PUBLIC_SITE_URL=http://localhost:8081\nEXPO_PUBLIC_ENV=development\n",
    ".github/workflows/deploy.yml": DEPLOY_WORKFLOW,
  });
  assert.equal(result.status, "pass", result.details.join("\n"));
  assert.match(result.details[0], /2 EXPO_PUBLIC_\* name\(s\)/);
});

test("public-env-passthrough: fails on a declared name deploy.yml never passes (#175's shape)", () => {
  const result = runOne("public-env-passthrough", {
    ".env.example": "EXPO_PUBLIC_SITE_URL=http://localhost:8081\nEXPO_PUBLIC_NEW_THING=\nEXPO_PUBLIC_ENV=development\n",
    ".github/workflows/deploy.yml": DEPLOY_WORKFLOW,
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /declares EXPO_PUBLIC_NEW_THING but .* never passes it/);
});

test("public-env-passthrough: fails on a name deploy.yml passes that nothing declares", () => {
  const result = runOne("public-env-passthrough", {
    ".env.example": "EXPO_PUBLIC_ENV=development\n",
    ".github/workflows/deploy.yml": DEPLOY_WORKFLOW,
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /passes EXPO_PUBLIC_SITE_URL, which .* does not declare/);
});

test("public-env-passthrough: a commented-out declaration is not a declaration", () => {
  const result = runOne("public-env-passthrough", {
    ".env.example": "EXPO_PUBLIC_SITE_URL=x\nEXPO_PUBLIC_ENV=development\n# EXPO_PUBLIC_LATER=\n",
    ".github/workflows/deploy.yml": DEPLOY_WORKFLOW,
  });
  assert.equal(result.status, "pass", result.details.join("\n"));
});

test("public-env-passthrough: this repository's deploy.yml passes every declared name", () => {
  const result = runChecks(["public-env-passthrough"], REPO_ROOT)[0];
  assert.equal(result.status, "pass", result.details.join("\n"));
});

test("no EXPO_PUBLIC_GOOGLE_ADS_* survives anywhere that would make it a declared variable again", () => {
  // #175's resolution: Kiarash decided against Google Ads, so the three names
  // were removed rather than wired up. This asserts the removal is complete
  // in the two files that decide whether the variable exists at all — a name
  // reappearing in `.env.example` alone is what created the bug the first
  // time (declared, read, passed by nothing).
  const ctx = createContext(REPO_ROOT);
  for (const file of [".env.example", ".github/workflows/deploy.yml"]) {
    const text = ctx.readText(file) ?? "";
    const declarations = text
      .split("\n")
      .filter((line) => /^\s*EXPO_PUBLIC_GOOGLE_ADS_[A-Z_]+\s*[:=]/.test(line));
    assert.deepEqual(declarations, [], `${file} still declares a Google Ads variable`);
  }
});

// ── csp-script-hash ────────────────────────────────────────────────────
//
// #194: three `sha256-` values written by hand into two policy files with
// nothing binding them to the scripts they authorise. Not a check that could
// not fail — a check that did not exist; `docs/design/ops.md` and
// `_headers`' own comment named the hazard in prose and that was the whole
// enforcement.

const CSP_SCRIPT = '\n(function () {\n  document.documentElement.dataset.theme = "light";\n})();\n';
const CSP_SCRIPT_HASH = createHash("sha256").update(CSP_SCRIPT, "utf8").digest("base64");
const EXPO_HYDRATE_HASH = createHash("sha256")
  .update("globalThis.__EXPO_ROUTER_HYDRATE__=true;", "utf8")
  .digest("base64");

function cspTree({ script = CSP_SCRIPT, declared = null } = {}) {
  const hashes = (declared ?? [CSP_SCRIPT_HASH, EXPO_HYDRATE_HASH])
    .map((h) => `'sha256-${h}'`)
    .join(" ");
  return {
    "apps/web/app/+html.tsx": `const PREHYDRATION_SCRIPT = \`${script}\`;\n`,
    "apps/api/src/middleware/securityHeaders.ts": `const CSP = ["script-src 'self' ${hashes}"].join("; ");\n`,
    "apps/web/public/_headers": `# documented above: 'sha256-deadbeefNotDeclaredJustMentionedInAComment='\n/*\n  Content-Security-Policy: default-src 'self'; script-src 'self' ${hashes}\n`,
  };
}

test("csp-script-hash: passes when both policies declare the script's real hash", () => {
  const result = runOne("csp-script-hash", cspTree());
  assert.equal(result.status, "pass", result.details.join("\n"));
  assert.match(result.details.join("\n"), new RegExp(`PREHYDRATION_SCRIPT: sha256-${CSP_SCRIPT_HASH.replace(/[+/=]/g, (c) => `\\${c}`)}`));
});

test("csp-script-hash: one added space to the script turns it red (#194's own experiment)", () => {
  const result = runOne("csp-script-hash", cspTree({ script: CSP_SCRIPT.replace("(function () {", "(function () { ") }));
  assert.equal(result.status, "fail");
  const text = result.details.join("\n");
  assert.match(text, /does not declare 'sha256-[^']+', the hash of PREHYDRATION_SCRIPT/);
  // The failure has to name the cause, because "a space" is not something
  // anyone will suspect on their own.
  assert.match(text, /exact bytes/);
  assert.match(text, /prettier reflow/);
  // And the old hash must be reported stale, not silently tolerated.
  assert.match(text, /matches no script in this tree/);
});

test("csp-script-hash: a stale hash left behind after a script edit fails", () => {
  const result = runOne("csp-script-hash", {
    ...cspTree({ declared: [CSP_SCRIPT_HASH, EXPO_HYDRATE_HASH, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="] }),
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /declares 'sha256-AAA[^']*', which matches no script in this tree/);
});

test("csp-script-hash: fails when the two hand-maintained policies disagree", () => {
  const tree = cspTree();
  tree["apps/web/public/_headers"] = `/*\n  Content-Security-Policy: script-src 'self' 'sha256-${CSP_SCRIPT_HASH}'\n`;
  const result = runOne("csp-script-hash", tree);
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /the two policies are maintained by hand and must stay identical/);
});

test("csp-script-hash: fails when one apps/site page's inline script diverges from its siblings", () => {
  const page = (theme) =>
    `<html><head><script src="/consent.js" defer></script><script>\n  var t = "${theme}";\n</script></head></html>\n`;
  const sitePages = {
    "apps/site/public/about.html": page("light"),
    "apps/site/public/privacy.html": page("light"),
    "apps/site/public/terms.html": page("dark"),
  };
  const result = runOne("csp-script-hash", { ...cspTree(), ...sitePages });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /carry 2 different inline <script> bodies/);
});

test("csp-script-hash: fails rather than passing when the script literal cannot be found", () => {
  const tree = cspTree();
  tree["apps/web/app/+html.tsx"] = "const SOMETHING_ELSE = `x`;\n";
  const result = runOne("csp-script-hash", tree);
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /could not find `const PREHYDRATION_SCRIPT/);
});

test("csp-script-hash: fails when the script interpolates, so source bytes are not browser bytes", () => {
  const tree = cspTree();
  tree["apps/web/app/+html.tsx"] = "const PREHYDRATION_SCRIPT = `var k = ${KEY};`;\n";
  const result = runOne("csp-script-hash", tree);
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /interpolates/);
});

test("csp-script-hash: skips a tree with no CSP at all", () => {
  const result = runOne("csp-script-hash", { "README.md": "# nothing\n" });
  assert.equal(result.status, "skip");
});

test("cspHashesIn ignores hashes that only appear in comments", () => {
  // `_headers` documents all three hashes in a comment directly above the
  // policy, so a whole-file scan would "find" hashes the policy never
  // declares — and the check would pass on a policy missing all of them.
  const text = "# 'sha256-AAA=' is the theme script\n/*\n  Content-Security-Policy: script-src 'sha256-BBB='\n";
  assert.deepEqual([...cspHashesIn(text, { commentPrefixes: ["#"] })], ["BBB="]);
});

test("templateLiteralBody takes the exact bytes between the backticks", () => {
  assert.equal(templateLiteralBody("const X = `\n  a();\n`;\n", "X"), "\n  a();\n");
  assert.equal(templateLiteralBody("const Y = `z`;", "X"), null);
});

test("inlineScriptBodies skips <script src=…> and keeps inline bodies in order", () => {
  assert.deepEqual(
    inlineScriptBodies('<script src="/consent.js" defer></script><script>a()</script><script>b()</script>'),
    ["a()", "b()"],
  );
});

test("csp-script-hash: this repository's real hashes match the scripts they authorise", () => {
  // The whole point of #194, against the real tree. Kiarash verified
  // sha256-0+1/dyhe… against a 1261-char script by hand; this asserts the
  // check computes the same thing, so an extractor grabbing the wrong bytes
  // cannot look like a policy that is genuinely in sync.
  //
  // The pinned value moves whenever `PREHYDRATION_SCRIPT` really changes —
  // it is sha256-Xrcu2v… over 1374 chars since 2026-09-08, when the root
  // redirect started carrying `location.search` across to `/welcome`. Pinned
  // rather than recomputed on purpose: a test that hashed the same source the
  // check hashes would agree with any bytes at all.
  const result = runChecks(["csp-script-hash"], REPO_ROOT)[0];
  assert.equal(result.status, "pass", result.details.join("\n"));
  const text = result.details.join("\n");
  assert.match(text, /PREHYDRATION_SCRIPT: sha256-Xrcu2vG2x\+FPB1xtg6DFrNGNiO3x0AQ6vK5XstpOJM8= — apps\/web\/app\/\+html\.tsx \(1374 chars\)/);
  assert.match(text, /apps\/site inline script: sha256-d6qbtEYff\/sB38YyzuzhASbVmmOidU\/UFC9mNit47j4=/);
  // The one hash it cannot compute must say so rather than blending in.
  assert.match(text, /NOT against Expo's actual output/);
});

// ── shell-syntax ───────────────────────────────────────────────────────

test("shell-syntax: passes for a valid script", () => {
  const result = runOne("shell-syntax", {
    "tools/geodata/fetch.sh": "#!/usr/bin/env bash\necho hi\n",
  });
  assert.equal(result.status, "pass");
});

test("shell-syntax: fails for a syntax error", () => {
  const result = runOne("shell-syntax", {
    "tools/geodata/fetch.sh": "#!/usr/bin/env bash\nif [ 1 -eq 1 ]; then\necho oops\n",
  });
  assert.equal(result.status, "fail");
});

test("shell-syntax: skips only a tree with neither shell scripts nor workflows", () => {
  const result = runOne("shell-syntax", {});
  assert.equal(result.status, "skip");
});

// #166: the tests above are the shape the audit called out — they can only
// fail against an invented `.sh` file, which this repository has never
// contained. Everything below runs against **this repository's own bytes**.

test("shell-syntax: this repo really does contain no .sh files, so the .sh glob alone guards nothing", () => {
  const shellFiles = [
    ...createContext(REPO_ROOT).walk("tools"),
    ...createContext(REPO_ROOT).walk(".github"),
  ].filter((f) => f.endsWith(".sh"));
  assert.deepEqual(shellFiles, [], "if a .sh file ever lands, this assertion is the place to notice");
});

test("shell-syntax: parses this repository's actual workflow run: blocks, and there are some", () => {
  const result = runChecks(["shell-syntax"], REPO_ROOT)[0];
  assert.equal(result.status, "pass", result.details.join("\n"));
  const blocks = Number(/and (\d+) workflow/.exec(result.details[0])?.[1]);
  assert.ok(blocks > 0, `expected real run: blocks to be parsed, got: ${result.details[0]}`);
});

test("shell-syntax: extracts every run: key the real workflows contain", () => {
  const ctx = createContext(REPO_ROOT);
  const files = ctx.walk(".github/workflows").filter((f) => /\.ya?ml$/.test(f));
  let runKeys = 0;
  let extracted = 0;
  for (const file of files) {
    const text = ctx.readText(file);
    runKeys += (text.match(/^\s*(?:-\s+)?run:/gm) ?? []).length;
    extracted += extractWorkflowRunBlocks(text).length;
  }
  assert.ok(runKeys > 0, "no run: keys in .github/workflows — has the layout changed?");
  assert.equal(extracted, runKeys, "the extractor silently dropped a run: block");
});

test("shell-syntax: goes red when a `fi` is removed from the real uptime.yml", () => {
  // The audit's own break-the-guard experiment, as a test. Uses the shipped
  // file's bytes rather than an invented script, so it cannot drift into
  // proving something about a fixture only.
  const real = createContext(REPO_ROOT).readText(".github/workflows/uptime.yml");
  assert.ok(real, ".github/workflows/uptime.yml is missing");
  const lines = real.split("\n");
  const fiAt = lines.findIndex((l) => l.trim() === "fi");
  assert.ok(fiAt > 0, "uptime.yml no longer contains a bare `fi` to remove");
  lines.splice(fiAt, 1);

  const good = runOne("shell-syntax", { ".github/workflows/uptime.yml": real });
  assert.equal(good.status, "pass", good.details.join("\n"));

  const broken = runOne("shell-syntax", { ".github/workflows/uptime.yml": lines.join("\n") });
  assert.equal(broken.status, "fail");
  assert.match(broken.details.join("\n"), /uptime\.yml:\d+: line \d+:/);
});

test("shell-syntax: fails rather than skips when workflows have run: blocks it cannot parse", () => {
  const result = runOne("shell-syntax", {
    ".github/workflows/py.yml": `name: Py
on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - shell: python
        run: |
          print("not bash")
`,
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /extracted none|no shell found at all/);
});

test("shell-syntax: fails rather than skips for a workflow tree containing no shell at all", () => {
  const result = runOne("shell-syntax", {
    ".github/workflows/uses-only.yml": `name: Uses
on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`,
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /no shell found at all/);
});

test("shell-syntax: \${{ }} expressions are substituted, not parsed as shell", () => {
  const result = runOne("shell-syntax", {
    ".github/workflows/expr.yml": `name: Expr
on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - run: |
          url="\${{ vars.SITE_URL }}/health"
          echo "$url"
`,
  });
  assert.equal(result.status, "pass", result.details.join("\n"));
});

test("extractWorkflowRunBlocks: dedents block scalars, keeps inline runs, and reads shell:", () => {
  const blocks = extractWorkflowRunBlocks(`name: X
on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm install --frozen-lockfile
      - name: Multi
        run: |
          set -euo pipefail
          if [ -n "$X" ]; then
            echo yes
          fi
      - name: Node
        shell: node
        run: console.log(1)
`);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].script, "pnpm install --frozen-lockfile");
  assert.equal(blocks[0].shell, null);
  assert.equal(
    blocks[1].script,
    'set -euo pipefail\nif [ -n "$X" ]; then\n  echo yes\nfi',
    "the block scalar must be dedented to column 0 and keep its relative indentation",
  );
  assert.equal(blocks[1].shell, null);
  assert.equal(blocks[2].shell, "node");
  // Line mapping: bash's "line 1" is the first line of the script body.
  assert.equal(blocks[1].firstScriptLine, 10);
});

// ── CLI: --only and --json ────────────────────────────────────────────

test("CLI --only runs a single named check", () => {
  const root = makeTree({
    "apps/api/migrations/0001_init.sql": "CREATE TABLE a (id TEXT);\n",
  });
  try {
    const out = execFileSync("node", [PREFLIGHT_BIN, "--only", "migrations", "--json", "--root", root], {
      encoding: "utf8",
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].name, "migrations");
    assert.equal(parsed[0].status, "pass");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI --json exits 1 and reports fail status on a broken tree", () => {
  const root = makeTree({
    "apps/api/migrations/0002_geo.sql": "CREATE TABLE a (id TEXT);\n", // starts at 0002
  });
  try {
    let out;
    let status = 0;
    try {
      out = execFileSync("node", [PREFLIGHT_BIN, "--only", "migrations", "--json", "--root", root], {
        encoding: "utf8",
      });
    } catch (error) {
      out = error.stdout;
      status = error.status;
    }
    assert.equal(status, 1);
    const parsed = JSON.parse(out);
    assert.equal(parsed[0].status, "fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI --list prints every check name without touching disk", () => {
  const out = execFileSync("node", [PREFLIGHT_BIN, "--list"], { encoding: "utf8" });
  assert.match(out, /fonts/);
  assert.match(out, /migrations/);
  assert.match(out, /shell-syntax/);
});

// ── gh-repo-context ────────────────────────────────────────────────────────
//
// The bug these cover shipped for real (#106): uptime.yml's alerting step
// called `gh issue create` from a job with no checkout, so every call died
// with "fatal: not a git repository" and no issue was ever filed. It went
// unnoticed because the step is `if: failure()` — it only runs when something
// is genuinely wrong, and until the first real failure nothing ever exercised
// it. A green run history was mistaken for a working alert.

const GH_ALERT_JOB = (env) => `name: Uptime
on:
  schedule:
    - cron: "*/15 * * * *"
jobs:
  health:
    runs-on: ubuntu-latest
    steps:
      - name: Check health
        run: curl -fsS https://example.test/health
      - name: Open an issue when unhealthy
        if: \${{ failure() }}
        env:
          GH_TOKEN: \${{ github.token }}
${env}        run: |
          gh issue create --title "down" --body "see run"
`;

test("gh-repo-context fails when a gh step has no checkout and no GH_REPO", () => {
  const result = runOne("gh-repo-context", {
    ".github/workflows/uptime.yml": GH_ALERT_JOB(""),
  });
  assert.equal(result.status, "fail");
  assert.match(result.details[0], /job "health" runs `gh`/);
  assert.match(result.details[0], /GH_REPO/);
});

test("gh-repo-context passes once GH_REPO is set on the step", () => {
  const result = runOne("gh-repo-context", {
    ".github/workflows/uptime.yml": GH_ALERT_JOB("          GH_REPO: ${{ github.repository }}\n"),
  });
  assert.equal(result.status, "pass");
});

test("gh-repo-context passes when the job checks the repo out instead", () => {
  const result = runOne("gh-repo-context", {
    ".github/workflows/report.yml": `name: Report
on:
  schedule:
    - cron: "0 * * * *"
jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: File a finding
        run: gh issue create --title "x" --body "y"
`,
  });
  assert.equal(result.status, "pass");
});

test("gh-repo-context only faults the job that lacks context, not its neighbour", () => {
  const result = runOne("gh-repo-context", {
    ".github/workflows/two.yml": `name: Two
on: [push]
jobs:
  fine:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: gh issue list
  broken:
    runs-on: ubuntu-latest
    steps:
      - run: gh issue create --title "t" --body "b"
`,
  });
  assert.equal(result.status, "fail");
  assert.equal(result.details.length, 1);
  assert.match(result.details[0], /job "broken"/);
});

test("gh-repo-context ignores words merely containing gh, and steps with no gh at all", () => {
  const result = runOne("gh-repo-context", {
    ".github/workflows/build.yml": `name: Build
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "highlight the through-put, weigh the light"
      - run: pnpm run build
`,
  });
  assert.equal(result.status, "pass");
  assert.match(result.details[0], /0 job\(s\) invoking gh/);
});

test("gh-repo-context skips a tree with no workflows rather than passing it", () => {
  const result = runOne("gh-repo-context", { "README.md": "# nothing here\n" });
  assert.equal(result.status, "skip");
});

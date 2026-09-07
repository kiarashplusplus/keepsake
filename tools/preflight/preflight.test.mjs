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
import { fileURLToPath } from "node:url";

import { runChecks, parseEnvExample, parseToml, migrationApplyOrder } from "./preflight.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREFLIGHT_BIN = path.join(HERE, "preflight.mjs");

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

const HTML_GOOD = `
  <style>
    @font-face { font-family: Fraunces; src: url(/fonts/Fraunces.ttf); }
    @font-face { font-family: Inter; src: url("/fonts/Inter.ttf"); }
  </style>
`;

test("fonts: passes when every referenced font exists and every font is referenced", () => {
  const result = runOne("fonts", {
    "apps/web/app/+html.tsx": HTML_GOOD,
    "apps/web/public/fonts/Fraunces.ttf": "x",
    "apps/web/public/fonts/Inter.ttf": "x",
  });
  assert.equal(result.status, "pass");
});

test("fonts: fails when a referenced font file is missing", () => {
  const result = runOne("fonts", {
    "apps/web/app/+html.tsx": HTML_GOOD,
    "apps/web/public/fonts/Fraunces.ttf": "x",
    // Inter.ttf missing
  });
  assert.equal(result.status, "fail");
  assert.match(result.details.join("\n"), /Inter\.ttf/);
});

test("fonts: warns on an unreferenced ttf without failing", () => {
  const result = runOne("fonts", {
    "apps/web/app/+html.tsx": HTML_GOOD,
    "apps/web/public/fonts/Fraunces.ttf": "x",
    "apps/web/public/fonts/Inter.ttf": "x",
    "apps/web/public/fonts/Extra.ttf": "x",
  });
  assert.equal(result.status, "warn");
  assert.match(result.details.join("\n"), /Extra\.ttf/);
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
test("migration-drift: skips with a reason when origin/main cannot be resolved", () => {
  const result = runDrift({ main: LANDED, plantOriginMain: false });
  assert.equal(result.status, "skip");
  assert.match(result.details.join("\n"), /no origin\/main ref/);
  assert.match(result.details.join("\n"), /did NOT run/);
});

test("migration-drift: that skip becomes a failure when a baseline is required", () => {
  const previous = process.env.PREFLIGHT_REQUIRE_GIT_BASELINE;
  process.env.PREFLIGHT_REQUIRE_GIT_BASELINE = "1";
  try {
    const result = runDrift({ main: LANDED, plantOriginMain: false });
    assert.equal(result.status, "fail");
    assert.match(result.details.join("\n"), /a baseline is required here/);
  } finally {
    if (previous === undefined) delete process.env.PREFLIGHT_REQUIRE_GIT_BASELINE;
    else process.env.PREFLIGHT_REQUIRE_GIT_BASELINE = previous;
  }
});

test("migration-drift: skips outside a git work tree rather than passing", () => {
  const result = runOne("migration-drift", {
    "apps/api/migrations/0001_init.sql": "CREATE TABLE a (id TEXT);\n",
  });
  assert.equal(result.status, "skip");
  assert.match(result.details.join("\n"), /not a git work tree/);
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

test("shell-syntax: skips when there are no shell scripts", () => {
  const result = runOne("shell-syntax", {});
  assert.equal(result.status, "skip");
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

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

import { runChecks, parseEnvExample, parseToml } from "./preflight.mjs";

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

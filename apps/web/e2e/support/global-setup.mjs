#!/usr/bin/env node
/**
 * Prepares the local Cloudflare state the Playwright suite runs against, then
 * exits so `wrangler dev` can start on top of it (see `playwright.config.ts`'s
 * `webServer.command`, which chains the two with `&&`).
 *
 * Three things happen here, in order:
 *
 *  1. The exported web bundle is checked for. The Worker serves `apps/web/dist`
 *     through its `[assets]` binding, so without an export every spec would
 *     fail on a blank page instead of a readable message.
 *  2. A dedicated `--persist-to` directory is wiped and re-migrated. The suite
 *     never shares `.wrangler/state` with `pnpm --filter @keepsake/api dev`:
 *     an e2e run deletes listings and flips statuses, which is not something
 *     to do to whatever a developer has been poking at by hand. Wiping it
 *     also means D1/R2/KV all start empty every run, so the daily KV budget
 *     counters in `src/moderation/budget.ts` can never carry over and starve
 *     a later run.
 *  3. Secrets are written to an env file inside that same directory.
 *     `ADMIN_TOKEN`/`TURNSTILE_SECRET` are Worker *secrets*, not `[vars]`, so
 *     `--var` is the wrong tool; `wrangler dev --env-file <path>` is the
 *     documented one, and — verified against wrangler 4.129 — it *replaces*
 *     the default `apps/api/.dev.vars` lookup rather than merging with it.
 *     That matters twice over: a developer's real `TURNSTILE_SECRET` can't
 *     leak in and start 403ing every write (the suite relies on
 *     `src/middleware/turnstile.ts` soft-passing when the secret is unset),
 *     and their real `ADMIN_TOKEN` can't shadow the `e2e-admin` one
 *     `admin.spec.ts` types into the gate.
 *
 * Listings/owners/photos are deliberately *not* seeded here: every spec
 * creates its own through the real API (`e2e/support/api.ts`), so the suite
 * exercises the same code path a giver does and two specs can never collide
 * over one shared fixture row.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCommitHash } from "../../scripts/resolveBuildInfo.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, "../..");
const API_DIR = path.resolve(WEB_DIR, "../api");
const REPO_DIR = path.resolve(WEB_DIR, "../..");
const DIST_INDEX = path.join(WEB_DIR, "dist", "index.html");
const DIST_VERSION = path.join(WEB_DIR, "dist", "version.json");

/** Kept under `.wrangler/` so the repo's existing ignore rule already covers
 * the SQLite files, the R2 blobs, and the secrets file written below. */
const STATE_DIR = path.join(API_DIR, ".wrangler", "e2e-state");
const ENV_FILE = path.join(STATE_DIR, "e2e.env");

/** Real GeoNames centroids, matching `apps/api/test/helpers.ts`'s
 * `seedStandardPostalCodes()` — 02139 is ~1.7 mi from 02144 and 01608 ~37 mi,
 * which is what makes a 25-mile radius mean something. */
const POSTAL_CODES = [
  ["US", "02144", "Somerville", "MA", 42.3958, -71.0967],
  ["US", "02139", "Cambridge", "MA", 42.3736, -71.1097],
  ["US", "01608", "Worcester", "MA", 42.2626, -71.8023],
];

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function wrangler(args) {
  execFileSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: API_DIR,
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
}

/** Web sources whose edits change what a screenshot looks like. `dist/` is
 * built from these, so any one of them being newer than the export means the
 * export no longer shows them. */
const UX_SOURCE_DIRS = [
  path.join(WEB_DIR, "app"),
  path.join(WEB_DIR, "src"),
  path.join(REPO_DIR, "packages"),
];

/** Newest mtime under `dir`, skipping the directories an export never reads.
 * Returns 0 for a path that does not exist. */
function newestMtime(dir) {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    const at = entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs;
    if (at > newest) newest = at;
  }
  return newest;
}

/**
 * A UX capture photographs `apps/web/dist`, and nothing in this harness ever
 * built it — `main()` below only checks that *an* export exists. So a capture
 * would happily rewrite all 74 committed frames from whatever bundle happened
 * to be sitting there: another branch's, or one built before the change under
 * review. That failure is silent and it inverts the point of the baseline —
 * you change a screen, run the capture, and the frames come back identical.
 *
 * (Not hypothetical. Taking this branch over, a capture run against a `dist`
 * built eleven hours earlier on a different branch photographed an `/admin`
 * predating `aria-label="Queue status"`, and the spec failed on a screen that
 * is correct in the source it was supposedly testing.)
 *
 * `pnpm e2e:ux` now exports first, so the ordinary path cannot go stale. This
 * is the backstop for a direct `UX_SHOTS=1 playwright test`, and it checks the
 * two ways an export drifts: built from another commit, or built before an
 * edit that is still only in the working tree. The commit comparison reuses
 * `resolveCommitHash()` — the same function that wrote the value — which is
 * the skew guard `scripts/write-version-json.mjs`'s header anticipated.
 */
function assertExportIsCurrent() {
  const rebuild = 'run "pnpm --filter @keepsake/web e2e:ux", which exports first';
  if (!existsSync(DIST_VERSION)) {
    console.error(`[e2e:setup] ${DIST_VERSION} is missing, so the export's commit can't be checked — ${rebuild}.`);
    process.exit(1);
  }

  const built = JSON.parse(readFileSync(DIST_VERSION, "utf8"));
  const head = resolveCommitHash();
  if (built.commit !== head) {
    console.error(
      `[e2e:setup] refusing to capture: apps/web/dist was built from ${built.commit}, HEAD is ${head}.\n` +
        `            The frames would show that commit's screens, not this one's — ${rebuild}.`,
    );
    process.exit(1);
  }

  const builtAt = Date.parse(built.builtAt);
  const edited = Math.max(...UX_SOURCE_DIRS.map(newestMtime));
  if (edited > builtAt) {
    console.error(
      `[e2e:setup] refusing to capture: a web source has changed since apps/web/dist was built ` +
        `(${new Date(edited).toISOString()} > ${built.builtAt}).\n` +
        `            The frames would not show that edit — ${rebuild}.`,
    );
    process.exit(1);
  }

  console.log(`[e2e:setup] export is current: ${built.commit}, built ${built.builtAt}`);
}

function main() {
  if (!existsSync(DIST_INDEX)) {
    console.error(
      `[e2e:setup] ${DIST_INDEX} is missing.\n` +
        "           The Worker serves the static export through its [assets] binding,\n" +
        "           so build it first: pnpm --filter @keepsake/web export",
    );
    process.exit(1);
  }

  // Only for a capture. An ordinary `pnpm e2e` asserts behaviour, which a
  // slightly-behind bundle still exercises honestly; only the frames commit a
  // stale bundle to the repo as if it were the current design.
  if (process.env.UX_SHOTS) assertExportIsCurrent();

  rmSync(STATE_DIR, { recursive: true, force: true });
  mkdirSync(STATE_DIR, { recursive: true });

  writeFileSync(
    ENV_FILE,
    [
      "# Generated by e2e/support/global-setup.mjs — do not edit, it is rewritten every run.",
      "ADMIN_TOKEN=e2e-admin",
      "# TURNSTILE_SECRET is deliberately absent: turnstile() soft-passes when it",
      "# is unset, which is what lets the browser submit without a real widget.",
      "",
    ].join("\n"),
    "utf8",
  );

  console.log("[e2e:setup] applying D1 migrations to", path.relative(API_DIR, STATE_DIR));
  wrangler(["d1", "migrations", "apply", "keepsake-db", "--local", "--persist-to", STATE_DIR]);

  const seedFile = path.join(STATE_DIR, "seed.sql");
  const values = POSTAL_CODES.map(
    ([country, code, place, admin1, lat, lng]) =>
      `(${sqlString(country)}, ${sqlString(code)}, ${sqlString(place)}, ${sqlString(admin1)}, ${lat}, ${lng})`,
  ).join(",\n  ");
  writeFileSync(
    seedFile,
    `INSERT OR REPLACE INTO postal_codes (country, code, place_name, admin1, lat, lng) VALUES\n  ${values};\n`,
    "utf8",
  );

  console.log("[e2e:setup] seeding postal codes 02144 / 02139 / 01608");
  wrangler(["d1", "execute", "keepsake-db", "--local", "--persist-to", STATE_DIR, "--file", seedFile]);

  console.log("[e2e:setup] ready");
}

main();

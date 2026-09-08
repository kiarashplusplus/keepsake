#!/usr/bin/env node
// Issue #17 left half a backup behind. `tools/backup-photos.mjs` copies the
// photo bytes every night; the database those bytes are meaningless without
// had **only** D1 Time Travel — 30 days, same account, no artefact you can
// hold. `docs/runbooks/restore.md` documented the export command and
// `docs/runbooks/launch-audit.md` recommended "one scheduled workflow that
// runs `d1 export` weekly into R2", and then nobody wrote it: a repo-wide
// search for a scheduled export found `backup-photos`, `ci`, `deploy`,
// `report-pressure`, `uptime` and nothing else. This is that workflow's
// script.
//
// What it protects against, and what it does not:
//   - It DOES cover the three cases Time Travel cannot: a mistake older than
//     30 days, wanting a copy that is not a D1 internal, and restoring into
//     a *new* database (the drill restore.md has already executed).
//   - It does NOT cover an account-level failure. `keepsake-db-<env>-backup`
//     is a bucket in the same Cloudflare account as the database it insures.
//     restore.md has said "keep an export somewhere that is not this
//     Cloudflare account" since before this script existed and that is still
//     unfixed — it needs a credential for a second provider that does not
//     exist here. Same weakness, same words, as backup-photos.mjs.
//
// **The `--table` list is not written down here on purpose.** `wrangler d1
// export` refuses this database outright (`0003_fts.sql` creates an FTS5
// virtual table), so the export has to name its tables one at a time — and a
// hard-coded list of them is exactly the bug #164 was: `listing_aspects`
// landed in `0006_aspects.sql`, the list was not updated, and every export
// taken by following the runbook came back with no aspects for any listing,
// unrecoverably, because `listings.aspects_backfilled_at` came back saying
// the backfill was already done. A second hard-coded copy of that list in
// this file would be a second place for it to rot, and preflight's
// `backup-tables` check only guards the runbook. So the runbook stays the
// single source of truth and this script reads it, through the very same
// parser the check uses. A new migration that adds a table now fails
// preflight, and fixing preflight fixes this script in the same edit.
//
// Usage:
//   node tools/backup-db.mjs --env preview
//   node tools/backup-db.mjs --env production
//
// Requires CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID (the same credentials
// deploy.yml and backup-photos.yml use) or an active `wrangler login`.
// Database names come from `apps/api/wrangler.toml`, so they cannot drift
// from what actually deploys. The destination bucket for a tier is always
// `keepsake-db-<env>-backup` and must already exist — this script copies
// bytes, it does not create infrastructure. Both buckets were created
// 2026-09-08 with a 90-day expiry lifecycle and a 30-day object lock; see
// docs/runbooks/restore.md#d1-export-backup.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { documentedBackupTables } from "./preflight/preflight.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const API_DIR = path.join(REPO_ROOT, "apps", "api");
const WRANGLER_TOML = path.join(API_DIR, "wrangler.toml");
const RESTORE_RUNBOOK = path.join(REPO_ROOT, "docs", "runbooks", "restore.md");

function parseArgs(argv) {
  const args = { env: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env") args.env = argv[++i];
  }
  return args;
}

// Same minimal-TOML approach as backup-photos.mjs and preflight.mjs: finds
// `database_name` inside the `[[env.<name>.d1_databases]]` block. Not a
// general parser, good enough for this file's shape.
function readDatabaseName(env) {
  const lines = readFileSync(WRANGLER_TOML, "utf8").split("\n");
  const header = `[[env.${env}.d1_databases]]`;
  const index = lines.findIndex((l) => l.trim() === header);
  if (index === -1) throw new Error(`Could not find ${header} in ${WRANGLER_TOML}`);
  for (let i = index + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("[")) break;
    const match = line.match(/^database_name\s*=\s*"([^"]+)"/);
    if (match) return match[1];
  }
  throw new Error(`Could not read database_name under ${header}`);
}

function wrangler(args) {
  return spawnSync("pnpm", ["exec", "wrangler", ...args], { cwd: API_DIR, encoding: "utf8" });
}

// Copied from backup-photos.mjs's `assertBackupBucketExists`, for the reason
// that comment gives at length: the first scheduled photo-backup run went
// green on both tiers having touched no bucket at all, because the thing it
// was counting happened to be zero. An export cannot be zero the same way —
// but the *upload* can still be attempted against a bucket that does not
// exist, and finding that out before doing three minutes of export work is
// strictly better than after. The probe is `r2 bucket info`: account-level,
// read-only, creates nothing.
function assertBucketExists(bucket) {
  const result = wrangler(["r2", "bucket", "info", bucket]);
  if (result.status === 0) {
    console.log(`backup-db: destination bucket ${bucket} confirmed present`);
    return;
  }
  console.error(
    `backup-db: cannot confirm the destination bucket ${bucket} exists. Refusing to report success.`,
  );
  console.error(`  wrangler r2 bucket info ${bucket} exited ${result.status}:`);
  console.error(`  ${(result.stderr || result.stdout || "(no output)").trim()}`);
  console.error(
    `  If the bucket does not exist, create it (once, per tier) — see ` +
      `docs/runbooks/restore.md#d1-export-backup. If it does exist, this is a credentials ` +
      `problem: CLOUDFLARE_API_TOKEN needs R2 read on this account.`,
  );
  process.exit(1);
}

// The tables to export, read from the runbook rather than restated. Empty is
// a hard failure and not a quiet zero-table export: `wrangler d1 export` with
// no `--table` would fall back to exporting everything, which is precisely
// the invocation this database rejects, and if it ever stopped rejecting it
// the dump would silently include the ~3.4 MB `postal_codes` seed table.
function tablesToExport() {
  const tables = documentedBackupTables(readFileSync(RESTORE_RUNBOOK, "utf8"));
  if (tables.length === 0) {
    console.error(
      `backup-db: docs/runbooks/restore.md contains no \`--table\` arguments, so there is no ` +
        `table list to export. That file is the single source of truth for it (#164) — run ` +
        `\`node tools/preflight/preflight.mjs --only backup-tables\` to see what it should say.`,
    );
    process.exit(1);
  }
  return tables;
}

// A dump that exported cleanly and contains no rows at all is the vacuous
// pass in this job's shape: exit 0, a file, an upload, a green check, and
// nothing recoverable inside it. An individual table being empty is normal
// (nobody has filed a report yet); *every* table being empty on a tier that
// has listings is not. So count the INSERTs per table and print them, and
// let the caller decide what an all-zero total means for its tier.
function summarise(dumpPath) {
  const text = readFileSync(dumpPath, "utf8");
  const perTable = new Map();
  for (const match of text.matchAll(/^INSERT INTO ["`]?([A-Za-z_][\w]*)/gm)) {
    perTable.set(match[1], (perTable.get(match[1]) ?? 0) + 1);
  }
  const total = [...perTable.values()].reduce((a, b) => a + b, 0);
  return { perTable, total, bytes: statSync(dumpPath).size };
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function main() {
  const { env } = parseArgs(process.argv.slice(2));
  if (!env || !["preview", "production"].includes(env)) {
    console.error("Usage: node tools/backup-db.mjs --env <preview|production>");
    process.exit(1);
  }

  const database = readDatabaseName(env);
  const bucket = `keepsake-db-${env}-backup`;
  console.log(`backup-db: env=${env} db=${database} bucket=${bucket}`);

  assertBucketExists(bucket);

  const tables = tablesToExport();
  console.log(`backup-db: ${tables.length} table(s) from restore.md: ${tables.join(", ")}`);

  const tmpDir = mkdtempSync(path.join(tmpdir(), "keepsake-db-backup-"));
  try {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const dumpPath = path.join(tmpDir, `${database}-${stamp}.sql`);

    const exportArgs = [
      "d1", "export", database, "--env", env, "--remote", "--no-schema",
      "--output", dumpPath, "-y",
      ...tables.flatMap((t) => ["--table", t]),
    ];
    const exported = wrangler(exportArgs);
    if (exported.status !== 0) {
      console.error(`backup-db: d1 export failed (exit ${exported.status})`);
      console.error((exported.stderr || exported.stdout || "(no output)").trim());
      process.exit(1);
    }

    const { perTable, total, bytes } = summarise(dumpPath);
    console.log(`backup-db: exported ${bytes} bytes, ${total} INSERT statement(s)`);
    for (const table of tables) {
      console.log(`  ${table}: ${perTable.get(table) ?? 0}`);
    }
    if (total === 0) {
      // Not a failure — preview is routinely empty and production was empty
      // as recently as 2026-09-07 — but say it in words, because "0 rows" and
      // "the query silently returned nothing" look identical in a check mark.
      console.log(
        `backup-db: the dump contains no rows. Legitimate on a tier with no data yet; ` +
          `read it as "nothing to lose", not "backed up".`,
      );
    }

    const key = `d1/${database}/${stamp}.sql`;
    const put = wrangler([
      "r2", "object", "put", `${bucket}/${key}`,
      "--env", env, "--remote", "-f", dumpPath, "--content-type", "application/sql",
    ]);
    if (put.status !== 0) {
      console.error(`backup-db: could not write ${bucket}/${key}`);
      console.error((put.stderr || put.stdout || "(no output)").trim());
      process.exit(1);
    }

    // Read it back and compare hashes. `put` exiting 0 says the request was
    // accepted; it does not say the object in the bucket is the file that
    // left here. This is the check PR #215 ran by hand for the photo backup
    // (672,825 bytes and SHA-256 30e0f038… from *both* buckets) — doing it in
    // the job means it is checked every night rather than the once.
    const readBack = path.join(tmpDir, "readback.sql");
    const got = wrangler(["r2", "object", "get", `${bucket}/${key}`, "--env", env, "--remote", "-f", readBack]);
    if (got.status !== 0) {
      console.error(`backup-db: wrote ${key} but could not read it back`);
      console.error((got.stderr || got.stdout || "(no output)").trim());
      process.exit(1);
    }
    const local = sha256(dumpPath);
    const remote = sha256(readBack);
    if (local !== remote) {
      console.error(`backup-db: read-back mismatch for ${key}`);
      console.error(`  local  sha256=${local} bytes=${bytes}`);
      console.error(`  remote sha256=${remote} bytes=${statSync(readBack).size}`);
      process.exit(1);
    }

    console.log(`backup-db: done — ${bucket}/${key} verified, sha256=${remote}, ${bytes} bytes`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`backup-db: ${error.message}`);
  process.exit(1);
});

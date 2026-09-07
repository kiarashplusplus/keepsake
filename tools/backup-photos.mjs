#!/usr/bin/env node
// Issue #17: R2 has no native object versioning exposed anywhere in this
// stack. Checked directly against the account this repo deploys to
// (`wrangler --version` 4.129.0, 2026-09-07): `wrangler r2 bucket` has
// create/update/list/info/delete/sippy/catalog/notification/domain/dev-url/
// local-uploads/lifecycle/cors/lock and nothing else — no "versioning"
// subcommand, and `wrangler r2 bucket info --json` returns no
// versioning-related field. `lifecycle` only expires, transitions storage
// class, or aborts incomplete multipart uploads; none of that recovers a
// deleted object. `sippy` migrates *into* R2 from AWS/GCS on read-miss, which
// is the wrong direction for a backup. So there is nothing to "turn on" —
// this script is the honest alternative the issue asks for instead: a
// scheduled, real, verified copy of every currently-referenced photo into a
// second bucket in the same account.
//
// What this does and does not fix, plainly:
//   - It DOES protect against the actually-observed risk: a bug in one of
//     orphanSweep's three delete predicates (apps/api/src/cron/orphanSweep.ts)
//     wrongly deleting a live photo. This script never deletes anything in
//     the backup bucket, so a photo copied here survives a bad `BUCKET.delete()`
//     on the primary bucket, even after the corresponding D1 row is also
//     gone — restore is "copy it back", not "hope D1 still points at it".
//   - As of #178 that protection no longer depends on this job winning a race
//     against orphanSweep. It used to: this workflow is scheduled before the
//     sweep's cron, GitHub's `schedule:` queue is best-effort, and the one
//     scheduled run this workflow has ever had started *after* the sweep's
//     trigger — in which case the sweep deletes the row first, the `SELECT`
//     below no longer sees it, nothing is copied, and the run passes. The
//     sweep now reads the backup bucket (`PHOTO_BACKUP_BUCKET`) and refuses
//     to delete a photo it has not copied, so a late run of this script
//     delays a deletion instead of losing the bytes. **What that makes this
//     script responsible for: actually running.** A backup that stops
//     entirely no longer loses photos, but it does stop orphan cleanup — the
//     sweep logs `photosDeferred` every night that happens.
//   - It does NOT fix the weakness restore.md already names for the D1
//     export path: "a backup living in the same account it insures against
//     is weak protection." Both buckets sit in the one Cloudflare account.
//     An account-level failure — suspension, compromise, a Cloudflare-side
//     R2 incident — takes both out together. Restore.md's answer for D1 is
//     "keep an export somewhere that is not this Cloudflare account"; the
//     same is true here and is NOT solved by this script. Getting photo
//     bytes to a genuinely separate provider needs credentials (an AWS/GCS
//     bucket, or a second Cloudflare account) that do not exist yet — that
//     is a decision and a credential for Kiarash, not something to fake.
//
// Copy semantics: additive only, keyed by object path, checked before
// copying (never re-uploads a key already present in the backup bucket —
// object bodies at a given key are immutable once a photo is created, so
// "already there" always means "already correct"). Nothing is ever deleted
// from the backup bucket by this script; that is what makes it resistant to
// the primary-bucket delete bug it exists to cover. The backup bucket has
// its own lifecycle expiry (set once by hand, see docs/runbooks/restore.md)
// so it does not grow forever even though this script never prunes it.
//
// Usage:
//   node tools/backup-photos.mjs --env preview
//   node tools/backup-photos.mjs --env production
//
// Requires CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID in the environment
// (same credentials `deploy.yml` uses) or an active `wrangler login` session.
// Reads `apps/api/wrangler.toml` to find each environment's D1 database name
// and primary R2 bucket name, so it can never drift from what production
// actually deploys against. The backup bucket for `<name>` is always
// `<name>-backup` and must already exist (`wrangler r2 bucket create
// <name>-backup`) — this script does not create infrastructure, only copies
// bytes into it.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const API_DIR = path.join(REPO_ROOT, "apps", "api");
const WRANGLER_TOML = path.join(API_DIR, "wrangler.toml");

const CONTENT_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function parseArgs(argv) {
  const args = { env: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env") args.env = argv[++i];
  }
  return args;
}

// Same minimal-TOML approach as tools/preflight/preflight.mjs: good enough
// for wrangler.toml's shape, not a general parser. Finds
// `database_name = "..."` and `bucket_name = "..."` inside the
// `[env.<name>.d1_databases]]` / `[[env.<name>.r2_buckets]]` blocks (or the
// unscoped ones when `env` is null, i.e. local dev).
function readEnvResources(env) {
  const text = readFileSync(WRANGLER_TOML, "utf8");
  const lines = text.split("\n");
  const d1Header = env ? `[[env.${env}.d1_databases]]` : "[[d1_databases]]";
  const r2Header = env ? `[[env.${env}.r2_buckets]]` : "[[r2_buckets]]";

  function valueAfter(headerLine) {
    for (let i = headerLine + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("[")) break; // next table/section
      const match = line.match(/^(database_name|bucket_name)\s*=\s*"([^"]+)"/);
      if (match) return match[2];
    }
    return null;
  }

  const d1Index = lines.findIndex((l) => l.trim() === d1Header);
  const r2Index = lines.findIndex((l) => l.trim() === r2Header);
  if (d1Index === -1 || r2Index === -1) {
    throw new Error(`Could not find ${d1Header} / ${r2Header} in ${WRANGLER_TOML}`);
  }
  const database = valueAfter(d1Index);
  const bucket = valueAfter(r2Index);
  if (!database || !bucket) {
    throw new Error(`Could not read database_name/bucket_name for env ${env ?? "(default)"}`);
  }
  return { database, bucket, backupBucket: `${bucket}-backup` };
}

function wrangler(args, extraOpts = {}) {
  return spawnSync("pnpm", ["exec", "wrangler", ...args], {
    cwd: API_DIR,
    encoding: "utf8",
    ...extraOpts,
  });
}

// Pulls every key currently referenced by a `photos` row — both the
// full-size and thumbnail variants. This is deliberately "everything live
// right now", not a time-boxed "recently active" window: querying D1 for the
// exact set of keys that matter is cheap and precise, so there's no reason
// to guess at a recency cutoff instead.
function listReferencedKeys(env, database) {
  const query = "SELECT r2_key_full, r2_key_thumb FROM photos";
  const result = wrangler(["d1", "execute", database, "--env", env, "--remote", "--json", "--command", query]);
  if (result.status !== 0) {
    throw new Error(`d1 execute failed (exit ${result.status}): ${result.stderr || result.stdout}`);
  }
  const parsed = JSON.parse(result.stdout);
  const rows = parsed[0]?.results ?? [];
  const keys = new Set();
  for (const row of rows) {
    if (row.r2_key_full) keys.add(row.r2_key_full);
    if (row.r2_key_thumb) keys.add(row.r2_key_thumb);
  }
  return [...keys];
}

// The backup bucket has to exist before any of this means anything, and
// nothing else in this script notices when it doesn't.
//
// This is here because of a real vacuous pass: the first scheduled run of
// `.github/workflows/backup-photos.yml` (2026-09-07 03:18 UTC) went green on
// BOTH tiers, and the production leg's whole log was "0 referenced key(s) in
// D1" — production had no `photos` rows yet, so the loop below never ran, no
// bucket was ever touched, and the check mark said nothing at all about
// whether `keepsake-photos-production-backup` had been created. A backup job
// that reports success without establishing that it has somewhere to back up
// to is exactly the class of defect AGENTS.md's table catalogues, and it
// would have kept reporting success right up until the first production
// photo — at which point the `put` fails and the bytes it was supposed to
// have been protecting were never protected.
//
// So: probe the bucket first, unconditionally, before the key count can make
// the run trivially green. `wrangler r2 bucket info` is the probe because it
// is account-level and read-only — it neither creates nor writes anything,
// and it needs no `--env` because the tier is already baked into the bucket
// name `readEnvResources` derived.
//
// The failure is deliberately not diagnosed further than it can honestly be:
// a non-zero exit here means "could not confirm the bucket", which is the
// bucket genuinely missing OR the credentials being absent or too narrow.
// wrangler's own stderr is printed verbatim so the reader can tell which,
// rather than this script guessing and naming the wrong one.
function assertBackupBucketExists(backupBucket) {
  const result = wrangler(["r2", "bucket", "info", backupBucket]);
  if (result.status === 0) {
    // Printed HERE, not by the caller. An earlier draft of this had the
    // caller log "confirmed present" on the line after the call, and
    // commenting the call out still printed it — a success message that
    // could be emitted without the check running is the same bug one level
    // up. The only code that can claim the bucket was confirmed is the code
    // that confirmed it.
    console.log(`backup-photos: backup bucket ${backupBucket} confirmed present`);
    return;
  }
  console.error(
    `backup-photos: cannot confirm the backup bucket ${backupBucket} exists, so this run would ` +
      `prove nothing even if it copied zero objects. Refusing to report success.`,
  );
  console.error(`  wrangler r2 bucket info ${backupBucket} exited ${result.status}:`);
  console.error(`  ${(result.stderr || result.stdout || "(no output)").trim()}`);
  console.error(
    `  If the bucket does not exist yet, create it (once, per tier) — see ` +
      `docs/runbooks/restore.md#r2-photo-backup:\n` +
      `    wrangler r2 bucket create ${backupBucket}\n` +
      `    wrangler r2 bucket lifecycle add ${backupBucket} expire-after-400d --expire-days 400 -y\n` +
      `  If it does exist, this is a credentials problem: CLOUDFLARE_API_TOKEN needs Workers R2 ` +
      `Storage read on this account.`,
  );
  process.exit(1);
}

function existsInBucket(env, bucket, key, tmpFile) {
  const result = wrangler(["r2", "object", "get", `${bucket}/${key}`, "--env", env, "--remote", "-f", tmpFile]);
  return result.status === 0;
}

function copyKey(env, { primaryBucket, backupBucket, key, tmpDir }) {
  const tmpFile = path.join(tmpDir, "object.bin");
  if (existsInBucket(env, backupBucket, key, tmpFile)) {
    return "skipped";
  }
  const get = wrangler(["r2", "object", "get", `${primaryBucket}/${key}`, "--env", env, "--remote", "-f", tmpFile]);
  if (get.status !== 0 || !existsSync(tmpFile)) {
    console.error(`  ✘ could not read ${primaryBucket}/${key} from primary: ${get.stderr || get.stdout}`);
    return "failed";
  }
  const ext = path.extname(key).toLowerCase();
  const contentType = CONTENT_TYPES[ext];
  const putArgs = ["r2", "object", "put", `${backupBucket}/${key}`, "--env", env, "--remote", "-f", tmpFile];
  if (contentType) putArgs.push("--content-type", contentType);
  const put = wrangler(putArgs);
  if (put.status !== 0) {
    console.error(`  ✘ could not write ${backupBucket}/${key}: ${put.stderr || put.stdout}`);
    return "failed";
  }
  return "copied";
}

async function main() {
  const { env } = parseArgs(process.argv.slice(2));
  if (!env || !["preview", "production"].includes(env)) {
    console.error("Usage: node tools/backup-photos.mjs --env <preview|production>");
    process.exit(1);
  }

  const { database, bucket, backupBucket } = readEnvResources(env);
  console.log(`backup-photos: env=${env} db=${database} primary=${bucket} backup=${backupBucket}`);

  // Before the key count can make this run trivially green. See the comment
  // on this function for the vacuous pass that put it here.
  assertBackupBucketExists(backupBucket);

  const keys = listReferencedKeys(env, database);
  console.log(`backup-photos: ${keys.length} referenced key(s) in D1`);
  if (keys.length === 0) {
    // Say so rather than letting a silent success be read as "photos are
    // backed up". It is a legitimate state (a tier with no listings), and it
    // is also indistinguishable in a check mark from a broken query.
    console.log(
      `backup-photos: nothing to copy — no photos row references any object on ${env}. ` +
        `The backup bucket exists (checked above); this run protected no bytes because there ` +
        `are none.`,
    );
  }

  const tmpDir = mkdtempSync(path.join(tmpdir(), "keepsake-backup-photos-"));
  const counts = { copied: 0, skipped: 0, failed: 0 };
  try {
    for (const key of keys) {
      const outcome = copyKey(env, { primaryBucket: bucket, backupBucket, key, tmpDir });
      counts[outcome]++;
      if (outcome === "copied") console.log(`  + copied ${key}`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(
    `backup-photos: done — copied=${counts.copied} skipped=${counts.skipped} (already backed up) failed=${counts.failed}`,
  );
  if (counts.failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

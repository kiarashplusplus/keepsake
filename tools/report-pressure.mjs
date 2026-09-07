#!/usr/bin/env node
// Issue #89: `REPORT_AUTOHIDE_THRESHOLD = 3` lets three independent
// reporters hide a live listing on their own. Nothing told a human it
// happened. `GET /health` is a *Worker* liveness check — an auto-hide
// changes a listing's `status`, not the Worker's — so `.github/workflows/
// uptime.yml` reported `ok: true` right through the event, and the
// `captureMessage` the auto-hide fires (apps/api/src/routes/listings.ts)
// goes to Workers Logs, which has no Tail Worker and no Logpush reading it
// on a schedule (docs/runbooks/incident.md). The only surface that knew was
// the admin queue, which pages nobody: it has to be opened.
//
// This is the scheduled read that escalates. `.github/workflows/
// report-pressure.yml` runs it hourly and files a deduplicated issue from
// what it prints, in the same shape uptime.yml files one.
//
// WHY IT READS D1 AND NOT `GET /api/admin/health`
// -----------------------------------------------
// The same numbers are in that endpoint's `report_pressure` block, and
// hitting it would be the obvious thing to do — but `ADMIN_TOKEN` is a
// *Worker secret* (`wrangler secret put`), and there is no GitHub Actions
// secret of that name in this repository. A workflow that curled the admin
// endpoint would 401 on every run forever, which is precisely the class of
// check AGENTS.md keeps a table of. `CLOUDFLARE_API_TOKEN` /
// `CLOUDFLARE_ACCOUNT_ID` *do* exist as GitHub Environment secrets
// (deploy.yml, backup-photos.yml) and already carry D1 access — deploy.yml
// runs `wrangler d1 migrations apply --remote` with them, and
// tools/backup-photos.mjs already does exactly this `wrangler d1 execute
// --remote --json` call against a real database. So this uses the
// credential that exists rather than inventing one that does not.
//
// The predicate below is deliberately the same one
// `fetchReportPressure` in apps/api/src/routes/admin.ts evaluates. Keep the
// two in step: if one changes, change the other, and re-run the local proof
// at the bottom of this comment.
//
// Usage:
//   node tools/report-pressure.mjs --env preview
//   node tools/report-pressure.mjs --env production
//   node tools/report-pressure.mjs --env preview --local --persist-to <dir>
//
// `--local` runs the identical queries against a local wrangler D1 instead
// of the remote one, which is how this script is verifiable without
// Cloudflare credentials — see docs/runbooks/incident.md#reports--abuse for
// the recorded run (a listing auto-hidden by three real POSTs to
// /api/listings/:id/reports against `wrangler dev --local`, then found by
// this script).
//
// Output: a human summary on stdout, and `findings=`/`fingerprint=`/
// `summary_file=` lines on $GITHUB_OUTPUT when running under Actions. The
// fingerprint is a hash of the listing ids involved, so the workflow can
// stay quiet about an alert it has already filed instead of commenting on
// the same open issue once an hour forever.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const API_DIR = path.join(REPO_ROOT, "apps", "api");
const WRANGLER_TOML = path.join(API_DIR, "wrangler.toml");

/** Matches `AUTOHIDDEN_SAMPLE_LIMIT` in apps/api/src/routes/admin.ts. An
 * alert naming twenty listings is already an emergency; naming two hundred
 * would only make the issue unreadable. */
const SAMPLE_LIMIT = 20;

const DEFAULT_THRESHOLD = 3;

export function parseArgs(argv) {
  const args = { env: null, local: false, persistTo: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env") args.env = argv[++i];
    else if (argv[i] === "--local") args.local = true;
    else if (argv[i] === "--persist-to") args.persistTo = argv[++i];
  }
  return args;
}

// Same minimal-TOML approach as tools/backup-photos.mjs and
// tools/preflight/preflight.mjs: good enough for wrangler.toml's shape, not
// a general parser.
export function readEnvConfig(env, tomlText) {
  const lines = tomlText.split("\n");
  const d1Header = env ? `[[env.${env}.d1_databases]]` : "[[d1_databases]]";
  const varsHeader = env ? `[env.${env}.vars]` : "[vars]";

  function valueAfter(headerIndex, key) {
    if (headerIndex === -1) return null;
    for (let i = headerIndex + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("[")) break; // next table/section
      const match = line.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`));
      if (match) return match[1];
    }
    return null;
  }

  const d1Index = lines.findIndex((l) => l.trim() === d1Header);
  if (d1Index === -1) throw new Error(`Could not find ${d1Header} in wrangler.toml`);
  const database = valueAfter(d1Index, "database_name");
  if (!database) throw new Error(`Could not read database_name for env ${env ?? "(default)"}`);

  const varsIndex = lines.findIndex((l) => l.trim() === varsHeader);
  const rawThreshold = valueAfter(varsIndex, "REPORT_AUTOHIDE_THRESHOLD");
  const parsed = Number.parseInt(rawThreshold ?? "", 10);
  // Falls back rather than throwing, for the same reason `parseIntVar` in
  // apps/api/src/env.ts does: a malformed var should degrade to the shipped
  // default, not silence the whole alert.
  const threshold = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_THRESHOLD;
  return { database, threshold };
}

/** Listings the report threshold took down that no admin has acted on
 * since. Mirrors `fetchReportPressure` in apps/api/src/routes/admin.ts. */
export function autohiddenSql(limit = SAMPLE_LIMIT) {
  return (
    "SELECT l.id AS listing_id, l.report_count AS report_count, MAX(e.created_at) AS autohidden_at " +
    "FROM listings l " +
    "JOIN moderation_events e ON e.listing_id = l.id AND e.kind = 'report_autohide' " +
    "WHERE l.status = 'hidden' " +
    "AND NOT EXISTS (SELECT 1 FROM moderation_events a WHERE a.listing_id = l.id AND a.kind = 'admin' AND a.created_at >= e.created_at) " +
    `GROUP BY l.id, l.report_count ORDER BY autohidden_at DESC LIMIT ${limit}`
  );
}

/** Still-live listings one report away from the same fate. */
export function nearThresholdSql(threshold, limit = SAMPLE_LIMIT) {
  const floor = Math.max(threshold - 1, 1);
  return (
    "SELECT id AS listing_id, report_count FROM listings " +
    `WHERE status = 'approved' AND report_count >= ${floor} ` +
    `ORDER BY report_count DESC, updated_at DESC LIMIT ${limit}`
  );
}

function wranglerD1(database, sql, { env, local, persistTo }) {
  const args = ["exec", "wrangler", "d1", "execute", database];
  if (env) args.push("--env", env);
  args.push(local ? "--local" : "--remote");
  if (persistTo) args.push("--persist-to", persistTo);
  args.push("--json", "--command", sql);

  const result = spawnSync("pnpm", args, {
    cwd: API_DIR,
    encoding: "utf8",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  if (result.status !== 0) {
    // Loud, not silent. A credential that has lost D1 access, a renamed
    // database, a wrangler that started prompting — every one of those must
    // turn the scheduled run red rather than reporting "nothing to see".
    throw new Error(`d1 execute failed (exit ${result.status}): ${result.stderr || result.stdout}`);
  }
  return firstResultSet(result.stdout);
}

/**
 * `wrangler d1 execute --json` pretty-prints one array of result sets, but
 * may prepend banner lines — and some of those banners *start with a
 * bracket* (`[wrangler:info] ...`), so a naive `indexOf("[")` would slice
 * from the wrong place and throw. Anchor on the first line that is exactly
 * `[` (the pretty-printed array's own opening), falling back to a plain
 * parse of the whole thing.
 */
export function firstResultSet(stdout) {
  const lines = stdout.split("\n");
  const open = lines.findIndex((line) => line.trim() === "[");
  const json = open === -1 ? stdout : lines.slice(open).join("\n");
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`d1 execute returned no parseable JSON (${err.message}): ${stdout.slice(0, 500)}`);
  }
  return parsed[0]?.results ?? [];
}

/** Stable identity for "this exact set of listings", so the workflow can
 * tell a new auto-hide from the same one it filed an hour ago. */
export function fingerprint(autohidden) {
  const ids = autohidden.map((row) => row.listing_id).sort();
  return createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 12);
}

function ago(ms, now) {
  const minutes = Math.floor(Math.max(0, now - ms) / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hr`;
  return `${Math.floor(hours / 24)} days`;
}

export function buildSummary({ env, threshold, autohidden, nearThreshold, now }) {
  const lines = [];
  lines.push(
    `**${autohidden.length}** listing(s) on \`${env}\` were auto-hidden by ${threshold} reports and no admin has acted on them since.`,
  );
  lines.push("");
  for (const row of autohidden) {
    lines.push(`- \`${row.listing_id}\` — ${row.report_count} reports, hidden ${ago(row.autohidden_at, now)} ago`);
  }
  if (nearThreshold.length > 0) {
    lines.push("");
    lines.push(`Also ${nearThreshold.length} live listing(s) one report from the same threshold:`);
    for (const row of nearThreshold) {
      lines.push(`- \`${row.listing_id}\` — ${row.report_count} reports`);
    }
  }
  lines.push("");
  lines.push(
    "Both directions matter: this is either a harmful listing that needs confirming, or a legitimate keepsake " +
      "taken down by coordinated reporters that needs restoring. From here they look identical, and both want " +
      "the same next step — open the admin queue's **Hidden** tab and decide. Any admin action clears the " +
      "listing off this alert automatically.",
  );
  lines.push("");
  lines.push("Runbook: docs/runbooks/incident.md#reports--abuse");
  return lines.join("\n");
}

function githubOutput(entries) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  appendFileSync(file, entries.map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.env || !["preview", "production"].includes(args.env)) {
    console.error("Usage: node tools/report-pressure.mjs --env <preview|production> [--local] [--persist-to <dir>]");
    process.exit(1);
  }

  const { database, threshold } = readEnvConfig(args.env, readFileSync(WRANGLER_TOML, "utf8"));
  const opts = { env: args.env, local: args.local, persistTo: args.persistTo };
  console.log(`report-pressure: env=${args.env} db=${database} threshold=${threshold} mode=${args.local ? "local" : "remote"}`);

  const autohidden = wranglerD1(database, autohiddenSql(), opts);
  const nearThreshold = wranglerD1(database, nearThresholdSql(threshold), opts);
  const now = Date.now();

  console.log(`report-pressure: ${autohidden.length} auto-hidden awaiting review, ${nearThreshold.length} near threshold`);
  for (const row of autohidden) {
    console.log(`  ! ${row.listing_id} — ${row.report_count} reports, hidden ${ago(row.autohidden_at, now)} ago`);
  }
  for (const row of nearThreshold) {
    console.log(`  ~ ${row.listing_id} — ${row.report_count} reports (still live)`);
  }

  if (autohidden.length === 0) {
    githubOutput([["findings", "0"]]);
    console.log("report-pressure: nothing awaiting review");
    return 0;
  }

  const summary = buildSummary({ env: args.env, threshold, autohidden, nearThreshold, now });
  // `RUNNER_TEMP` on Actions; anywhere but the checkout locally, so a local
  // run never leaves an untracked file in the working tree.
  const summaryFile = path.join(process.env.RUNNER_TEMP || tmpdir(), `report-pressure-${args.env}.md`);
  writeFileSync(summaryFile, summary, "utf8");
  githubOutput([
    ["findings", String(autohidden.length)],
    ["fingerprint", fingerprint(autohidden)],
    ["summary_file", summaryFile],
  ]);
  console.log(`\n${summary}\n`);
  return 0;
}

// Importable for tests without running the CLI (`node --test`), the same way
// tools/preflight/preflight.mjs separates `runChecks` from its own entry.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}

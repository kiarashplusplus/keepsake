#!/usr/bin/env node
// Builds apps/api/seeds/postal_codes.sql from GeoNames' postal-code exports.
//
// No dependency beyond the `curl` and `unzip` binaries already on every dev
// machine and CI runner: GeoNames ships each country as a zip containing one
// tab-separated `<CC>.txt`, and streaming that through `unzip -p` avoids
// pulling in a zip-reading npm package for three small files fetched rarely
// (this is a manual regeneration tool, not something CI runs per PR).
//
// Columns in GeoNames' postal-code export (see their readme.txt):
//   country code, postal code, place name,
//   admin name1, admin code1, admin name2, admin code2, admin name3, admin code3,
//   latitude, longitude, accuracy
//
// Usage:
//   node tools/geodata/build-postal-seed.mjs [--out <file>] [--countries US,CA,GB] [--dry-run]
//
// See docs/runbooks/geodata.md for how/when to regenerate and load this.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const SOURCE_URLS = {
  US: "https://download.geonames.org/export/zip/US.zip",
  CA: "https://download.geonames.org/export/zip/CA.zip",
  GB: "https://download.geonames.org/export/zip/GB.zip",
};

export const CC_BY_NOTICE_LINES = [
  "Postal code data from GeoNames (https://www.geonames.org/),",
  "licensed under Creative Commons Attribution 4.0 (CC BY 4.0):",
  "https://creativecommons.org/licenses/by/4.0/",
  'Attribution ("GeoNames") is required wherever this data is displayed — see the About page.',
];

const DEFAULT_OUT = "apps/api/seeds/postal_codes.sql";
const BATCH_SIZE = 500;

function parseArgs(argv) {
  const args = { out: DEFAULT_OUT, countries: ["US", "CA", "GB"], dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") args.out = argv[++i];
    else if (arg === "--countries") args.countries = splitCountries(argv[++i]);
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg.startsWith("--out=")) args.out = arg.slice("--out=".length);
    else if (arg.startsWith("--countries=")) args.countries = splitCountries(arg.slice("--countries=".length));
    else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

function splitCountries(value) {
  return value.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
}

// Fetches `<CC>.zip` and returns the text of `<CC>.txt` inside it. curl does
// the download (follows redirects, fails loudly on a non-2xx status) and
// `unzip -p` streams the one member we want straight to stdout — nothing is
// left on disk once the temp dir is cleaned up.
export function downloadCountryText(country, url, workDir, exec = execFileSync) {
  const zipPath = path.join(workDir, `${country}.zip`);
  exec("curl", ["-sL", "--fail", url, "-o", zipPath], { stdio: ["ignore", "ignore", "inherit"] });
  return exec("unzip", ["-p", zipPath, `${country}.txt`], {
    maxBuffer: 1024 * 1024 * 300,
  }).toString("utf8");
}

export function parseGeonamesRows(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    const [country, postalCode, placeName, admin1Name, , , , , , lat, lng] = cols;
    rows.push({
      country,
      postalCode: postalCode ?? "",
      placeName: (placeName ?? "").trim(),
      admin1: (admin1Name ?? "").trim() || null,
      lat: Number(lat),
      lng: Number(lng),
    });
  }
  return rows;
}

// US: keep the first 5 digits (ZIP+4 in the source is truncated to ZIP5).
// CA: first 3 characters of the postal code, uppercased — the FSA (Forward
//     Sortation Area), which is as fine-grained as GeoNames' CA export goes.
// GB: the outward code (everything before the space), uppercased. GeoNames'
//     GB export is already at outward-code granularity, so this is really
//     just normalizing case/whitespace, not truncating a finer code.
function normalizeCode(country, rawCode) {
  const code = (rawCode ?? "").trim().toUpperCase();
  if (country === "US") {
    const match = code.match(/^\d{5}/);
    return match ? match[0] : null;
  }
  if (country === "CA") {
    return code.length >= 3 ? code.slice(0, 3) : null;
  }
  if (country === "GB") {
    if (!code) return null;
    return code.includes(" ") ? code.split(" ")[0] : code;
  }
  return null;
}

// One row per normalized code: the first GeoNames row to produce a given
// code wins (e.g. many CA FSA-level rows collapse onto one "M5V" row) —
// later duplicates are geographically close enough that ordering doesn't
// matter, but a rule beats an unspecified last-write-wins.
export function buildSeedRows(country, rawRows) {
  const byCode = new Map();
  for (const row of rawRows) {
    const code = normalizeCode(country, row.postalCode);
    if (!code) continue;
    if (!Number.isFinite(row.lat) || !Number.isFinite(row.lng)) continue;
    if (byCode.has(code)) continue;
    byCode.set(code, {
      country,
      code,
      placeName: row.placeName || code,
      admin1: row.admin1,
      lat: row.lat,
      lng: row.lng,
    });
  }
  return [...byCode.values()];
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return sqlString(value);
}

export function renderSql(rows, { countsPerCountry, generatedAt = new Date() }) {
  const header = [
    "-- Generated by tools/geodata/build-postal-seed.mjs. Do not hand-edit — regenerate instead.",
    `-- Generated: ${generatedAt.toISOString()}`,
    "-- Sources:",
    ...Object.entries(SOURCE_URLS).map(([c, u]) => `--   ${c}: ${u}`),
    "--",
    ...CC_BY_NOTICE_LINES.map((l) => `-- ${l}`),
    "--",
    `-- Row counts: ${Object.entries(countsPerCountry).map(([c, n]) => `${c}=${n}`).join(", ")}, total=${rows.length}`,
    "-- Regenerate: node tools/geodata/build-postal-seed.mjs (see docs/runbooks/geodata.md)",
    "",
  ].join("\n");

  const statements = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const values = batch
      .map((r) => `(${sqlValue(r.country)}, ${sqlValue(r.code)}, ${sqlValue(r.placeName)}, ${sqlValue(r.admin1)}, ${sqlValue(r.lat)}, ${sqlValue(r.lng)})`)
      .join(",\n");
    statements.push(`INSERT OR REPLACE INTO postal_codes (country, code, place_name, admin1, lat, lng) VALUES\n${values};`);
  }

  return `${header}\n${statements.join("\n\n")}\n`;
}

async function main(argv) {
  const args = parseArgs(argv);
  const unknown = args.countries.filter((c) => !SOURCE_URLS[c]);
  if (unknown.length > 0) {
    console.error(`unknown countries: ${unknown.join(", ")} (expected a subset of ${Object.keys(SOURCE_URLS).join(", ")})`);
    return 2;
  }

  const workDir = mkdtempSync(path.join(tmpdir(), "keepsake-geodata-"));
  try {
    const countsPerCountry = {};
    let allRows = [];
    for (const country of args.countries) {
      const url = SOURCE_URLS[country];
      process.stderr.write(`Fetching ${country} from ${url} ...\n`);
      const text = downloadCountryText(country, url, workDir);
      const rawRows = parseGeonamesRows(text);
      const seedRows = buildSeedRows(country, rawRows);
      countsPerCountry[country] = seedRows.length;
      allRows = allRows.concat(seedRows);
      process.stderr.write(`  ${country}: ${rawRows.length} raw row(s) -> ${seedRows.length} normalized row(s)\n`);
    }

    if (args.dryRun) {
      console.log(JSON.stringify({ counts: countsPerCountry, total: allRows.length }, null, 2));
      return 0;
    }

    const sql = renderSql(allRows, { countsPerCountry });
    const outDir = path.dirname(args.out);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(args.out, sql);
    const { size } = statSync(args.out);
    process.stderr.write(`Wrote ${args.out}: ${allRows.length} row(s), ${(size / 1024).toFixed(1)} KB\n`);
    return 0;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main(process.argv.slice(2)));
}

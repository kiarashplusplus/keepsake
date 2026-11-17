#!/usr/bin/env node
/**
 * Gifting-culture pipeline: Wikipedia → neutral per-city JSON.
 *
 *   node tools/gifting-culture/pipeline.mjs locations --countries JP,US --min-population 500000
 *   node tools/gifting-culture/pipeline.mjs collect [--only Q35765,Q60] [--limit 20]
 *   node tools/gifting-culture/pipeline.mjs all --countries JP --min-population 1000000
 *
 * Run with NODE_USE_ENV_PROXY=1 behind an HTTPS proxy (Node's fetch ignores
 * HTTPS_PROXY otherwise). README.md has the output schema and what the data
 * can and cannot be used to claim.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createClient, DEFAULT_USER_AGENT, isCompliantUserAgent } from "./lib/http.mjs";
import { authFromEnv } from "./lib/oauth.mjs";
import {
  citiesByQidQuery,
  citiesQuery,
  entityDetails,
  listCountries,
  mergeCityRows,
  sparql,
} from "./lib/wikidata.mjs";
import { collectSubject } from "./lib/sources.mjs";
import { compileCity, cityFileName } from "./lib/compile.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const USAGE = `usage: pipeline.mjs <locations|collect|all> [options]

locations   cities from Wikidata → <out>/locations.json
  --countries JP,US        ISO 3166-1 alpha-2 codes (default: every country)
  --min-population N       default 1000000
  --qids Q60,Q1490         exact cities instead of a population query

collect     Wikipedia passages for each city in locations.json → <out>/cities/
  --only Q60,Q1490         just these cities
  --limit N                the N most populous cities only
  --search-limit N         search results per query (default 8, 0 = no search)

common
  --out DIR                default tools/gifting-culture/out
  --refresh                ignore the HTTP cache (responses are re-cached)
  --rpm N                  requests/minute to Wikimedia APIs (default: from your tier, see below)

identity (environment)
  WIKIMEDIA_USER_AGENT     "name/version (https://your.site; you@example.org)". Without a
                           URL or email you are "unidentified": 10 req/min, shared per IP.
  WIKIMEDIA_CLIENT_ID      OAuth 2 client-credentials consumer (meta.wikimedia.org);
  WIKIMEDIA_CLIENT_SECRET  requests then count against that account's tier.
  WIKIMEDIA_ACCESS_TOKEN   owner-only token, as an alternative (needs cookies; handled).
`;

function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      countries: { type: "string" },
      "min-population": { type: "string", default: "1000000" },
      qids: { type: "string" },
      only: { type: "string" },
      limit: { type: "string" },
      "search-limit": { type: "string", default: "8" },
      out: { type: "string", default: path.join(HERE, "out") },
      refresh: { type: "boolean", default: false },
      rpm: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  const list = (s) =>
    s
      ? s
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
      : null;
  return {
    stage: positionals[0],
    help: values.help,
    countries: list(values.countries)?.map((c) => c.toUpperCase()) ?? null,
    minPopulation: Number(values["min-population"]),
    qids: list(values.qids),
    only: list(values.only),
    limit: values.limit ? Number(values.limit) : null,
    searchLimit: Number(values["search-limit"]),
    out: path.resolve(values.out),
    refresh: values.refresh,
    rpm: values.rpm ? Number(values.rpm) : undefined,
  };
}

const log = (...args) => console.error(...args);

function writeJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

async function stageLocations(client, opts) {
  const rows = [];
  const failedShards = [];
  if (opts.qids) {
    for (let i = 0; i < opts.qids.length; i += 100) {
      rows.push(...(await sparql(client, citiesByQidQuery(opts.qids.slice(i, i + 100)))));
    }
  } else {
    const all = await listCountries(client);
    const wanted = opts.countries ? all.filter((c) => opts.countries.includes(c.iso2)) : all;
    const unknown = (opts.countries ?? []).filter((c) => !all.some((x) => x.iso2 === c));
    if (unknown.length)
      throw new Error(`no current Wikidata country has ISO code(s): ${unknown.join(", ")}`);
    for (const [i, country] of wanted.entries()) {
      log(
        `  [${i + 1}/${wanted.length}] ${country.iso2} cities ≥ ${opts.minPopulation.toLocaleString("en")}`,
      );
      try {
        rows.push(
          ...(await sparql(
            client,
            citiesQuery({ iso2: country.iso2, minPopulation: opts.minPopulation }),
          )),
        );
      } catch (error) {
        log(`    FAILED: ${error.message}`);
        failedShards.push({ iso2: country.iso2, error: error.message });
      }
    }
  }

  const cities = mergeCityRows(rows);
  const parentQids = [...new Set(cities.flatMap((c) => [...c.regions, ...c.countries]))];
  log(
    `  ${cities.length} cities, ${parentQids.length} regions/countries — fetching labels and demonyms`,
  );
  const details = await entityDetails(client, [...cities.map((c) => c.qid), ...parentQids]);
  const cultureQids = [...new Set([...details.values()].flatMap((d) => d.cultureItems))];
  const cultureDetails = await entityDetails(client, cultureQids);

  const node = (qid, kind) => {
    const d = details.get(qid) ?? {
      qid,
      label: null,
      title: null,
      demonyms: [],
      iso2: null,
      cultureItems: [],
    };
    return {
      qid,
      kind,
      title: d.title,
      label: d.label,
      demonyms: d.demonyms,
      iso2: d.iso2,
      cultureTitles: d.cultureItems.map((q) => cultureDetails.get(q)?.title).filter(Boolean),
    };
  };

  const nodes = {};
  for (const city of cities) {
    for (const r of city.regions) nodes[r] ??= node(r, "region");
    for (const c of city.countries) nodes[c] = node(c, "country"); // a country is never demoted to a region
  }
  const out = cities
    .map((c) => ({
      ...node(c.qid, "city"),
      title: c.title,
      population: c.population,
      coordinates: c.coordinates,
      regions: c.regions,
      countries: c.countries,
    }))
    .sort((a, b) => (b.population ?? 0) - (a.population ?? 0));

  writeJson(path.join(opts.out, "locations.json"), {
    generatedAt: new Date().toISOString(),
    params: {
      countries: opts.countries,
      minPopulation: opts.qids ? null : opts.minPopulation,
      qids: opts.qids,
    },
    failedShards,
    cities: out,
    nodes,
  });
  log(`  wrote ${path.relative(process.cwd(), path.join(opts.out, "locations.json"))}`);
  if (failedShards.length) {
    throw new Error(
      `${failedShards.length} country shard(s) failed: ${failedShards.map((s) => s.iso2).join(", ")} — the city list is incomplete`,
    );
  }
}

async function stageCollect(client, opts) {
  const locationsFile = path.join(opts.out, "locations.json");
  if (!existsSync(locationsFile))
    throw new Error(`${locationsFile} not found — run the locations stage first`);
  const { cities: allCities, nodes } = JSON.parse(readFileSync(locationsFile, "utf8"));

  let cities = opts.only ? allCities.filter((c) => opts.only.includes(c.qid)) : allCities;
  if (opts.only) {
    const missing = opts.only.filter((q) => !cities.some((c) => c.qid === q));
    if (missing.length) throw new Error(`not in locations.json: ${missing.join(", ")}`);
  }
  if (opts.limit) cities = cities.slice(0, opts.limit);

  const memo = new Map();
  const collect = (subject, searchLimit) => {
    if (!memo.has(subject.qid))
      memo.set(subject.qid, collectSubject(client, subject, { searchLimit, log }));
    return memo.get(subject.qid);
  };
  // Regions are numerous and rarely have gifting content of their own that
  // search would find but their own and "Culture of" articles would not.
  const searchFor = { city: opts.searchLimit, region: 0, country: opts.searchLimit };

  const failures = [];
  const generatedAt = new Date().toISOString();
  for (const [i, city] of cities.entries()) {
    log(`[${i + 1}/${cities.length}] ${city.title} (${city.qid})`);
    try {
      const regions = city.regions.map((q) => nodes[q]).filter((n) => n?.title);
      const countries = city.countries.map((q) => nodes[q]).filter((n) => n?.title);
      const collections = {
        city: await collect(city, searchFor.city),
        regions: await Promise.all(regions.map((r) => collect(r, searchFor.region))),
        countries: await Promise.all(countries.map((c) => collect(c, searchFor.country))),
      };
      const record = compileCity({ city, regions, countries, collections, generatedAt });
      const iso = countries[0]?.iso2 ?? "XX";
      writeJson(path.join(opts.out, "cities", iso, cityFileName(city)), record);
      log(
        `  → coverage ${record.coverage.level}: ${JSON.stringify(record.coverage.strongPassages)}`,
      );
    } catch (error) {
      log(`  FAILED: ${error.message}`);
      failures.push({ qid: city.qid, title: city.title, error: error.message });
      memo.clear(); // a rejected promise must not be served to the next city
    }
  }

  writeIndex(opts.out, failures);
  log(
    `HTTP: ${client.stats.requests} requests, ${client.stats.cacheHits} cache hits, ` +
      `${client.stats.retries} retries (${client.stats.rateLimited} rate-limited); pace ended at ${Math.round(client.pace.currentRpm)}/min`,
  );
  if (failures.length)
    throw new Error(`${failures.length} of ${cities.length} cities failed; see index.json`);
}

/** Rebuilt from whatever city files exist, so partial and `--only` runs still leave a true index. */
function writeIndex(out, failures) {
  const dir = path.join(out, "cities");
  const entries = [];
  for (const iso of existsSync(dir) ? readdirSync(dir).sort() : []) {
    for (const file of readdirSync(path.join(dir, iso)).sort()) {
      const record = JSON.parse(readFileSync(path.join(dir, iso, file), "utf8"));
      entries.push({
        qid: record.location.qid,
        name: record.location.name,
        countries: record.location.countries.map((c) => c.iso2),
        file: `cities/${iso}/${file}`,
        generatedAt: record.generatedAt,
        coverage: record.coverage,
      });
    }
  }
  const byLevel = {};
  for (const e of entries) byLevel[e.coverage.level] = (byLevel[e.coverage.level] ?? 0) + 1;
  writeJson(path.join(out, "index.json"), {
    generatedAt: new Date().toISOString(),
    cities: entries.length,
    byCoverageLevel: byLevel,
    failures,
    entries,
  });
}

async function main() {
  const opts = parse(process.argv.slice(2));
  if (opts.help || !["locations", "collect", "all"].includes(opts.stage)) {
    process.stdout.write(USAGE);
    process.exit(opts.help ? 0 : 2);
  }
  const userAgent = process.env.WIKIMEDIA_USER_AGENT || DEFAULT_USER_AGENT;
  const auth = authFromEnv(process.env, { userAgent });
  if (!isCompliantUserAgent(userAgent)) {
    log(
      "warning: WIKIMEDIA_USER_AGENT has no URL or email, so Wikimedia treats this client as " +
        'unidentified (10 requests/minute, shared with everyone on this IP). See README.md, "Rate limits".',
    );
  }
  const client = createClient({
    userAgent,
    auth,
    requestsPerMinute: opts.rpm,
    cacheDir: path.join(opts.out, ".cache", "http"),
    refresh: opts.refresh,
    log,
  });
  log(
    `identity: ${auth ? auth.kind : "unauthenticated"}, user agent ${isCompliantUserAgent(userAgent) ? "compliant" : "NOT compliant"}, ` +
      `pacing ${client.pace.ceilingRpm} requests/minute`,
  );
  if (opts.stage === "locations" || opts.stage === "all") {
    log("locations:");
    await stageLocations(client, opts);
  }
  if (opts.stage === "collect" || opts.stage === "all") {
    log("collect:");
    await stageCollect(client, opts);
  }
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});

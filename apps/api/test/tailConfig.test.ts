/**
 * The two wrangler configs must agree, and nothing at runtime can see that
 * they do.
 *
 * Issue #159 gave this package a second Worker — `keepsake-tail`, configured
 * by `wrangler.tail.toml` — and a second config is a second place for the
 * per-environment restating this repo already knows is easy to get wrong.
 * Two specific failures are possible here, and both deploy cleanly:
 *
 *  1. **A tier whose `[[tail_consumers]]` names a script that tier does not
 *     deploy.** Wrangler does not inherit `tail_consumers` into a named
 *     environment — it warns and carries on — so the failure mode is a tier
 *     whose entire error stream goes nowhere while every test passes and the
 *     panel that reads the table reports `unconfigured` forever.
 *  2. **A tier whose tail Worker writes to another tier's database.** Preview
 *     error lines landing in the production database is a privacy incident,
 *     not a mix-up: these rows are error text from real requests.
 *
 * Modelled on `test/bulkCaps.test.ts` and `test/robotsConfig.test.ts`: the
 * assertions run against the real **text** of both files, injected by
 * `vitest.config.ts` (read there in Node, since the Workers runtime has no
 * `node:fs`), because a runtime check can only ever see the one environment
 * the test fixture booted with, and the whole risk here is the two blocks it
 * cannot see.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const api = (env as unknown as { WRANGLER_TOML_TEXT: string }).WRANGLER_TOML_TEXT;
const tail = (env as unknown as { TAIL_WRANGLER_TOML_TEXT: string }).TAIL_WRANGLER_TOML_TEXT;

/**
 * Every table header in the file, in order, with the byte range of its body —
 * where a body runs to the next header of *either* kind, or to the end of the
 * file. Sliced by index rather than by a lookahead regex on purpose: a
 * `(?=^\[|$)` lookahead silently mis-slices the last table in a file, which
 * is exactly where `[env.production]`'s bindings live in both of these
 * configs. Same trade `parseToml` in `tools/preflight/preflight.mjs` makes —
 * it understands the subset of TOML these two files use, and nothing more.
 */
function tables(text: string): { name: string; array: boolean; body: string }[] {
  const headers = [...text.matchAll(/^\[(\[?)([^\]]+)\]\]?\s*$/gm)];
  return headers.map((header, i) => ({
    name: (header[2] ?? "").trim(),
    array: header[1] === "[",
    body: text.slice(
      (header.index ?? 0) + header[0].length,
      i + 1 < headers.length ? (headers[i + 1]?.index ?? text.length) : text.length,
    ),
  }));
}

/** The bodies of every `[[name]]` array-table with this exact name. */
function arrayTables(text: string, name: string): string[] {
  return tables(text)
    .filter((entry) => entry.array && entry.name === name)
    .map((entry) => entry.body);
}

function stringValue(body: string, key: string): string | undefined {
  const match = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m").exec(body);
  return match?.[1];
}

/** The single-bracket `[name]` table's body. */
function table(text: string, name: string): string | undefined {
  return tables(text).find((entry) => !entry.array && entry.name === name)?.body;
}

/** `name` at the top level of a config, i.e. before the first table header. */
function topLevelName(text: string): string | undefined {
  const head = text.slice(0, text.search(/^\[/m));
  return stringValue(head, "name");
}

interface Tier {
  label: string;
  /** How a table is prefixed for this environment in both files. */
  prefix: string;
  /** Wrangler's own naming rule for a named environment: `<name>-<env>`. */
  suffix: string;
  database: string;
}

const TIERS: Tier[] = [
  { label: "top level (local dev)", prefix: "", suffix: "", database: "keepsake-db" },
  { label: "[env.preview]", prefix: "env.preview.", suffix: "-preview", database: "keepsake-db-preview" },
  { label: "[env.production]", prefix: "env.production.", suffix: "-production", database: "keepsake-db-production" },
];

describe("the API Worker's tail consumers (wrangler.toml)", () => {
  it.each(TIERS)("$label declares a consumer, because wrangler inherits none", ({ prefix }) => {
    const consumers = arrayTables(api, `${prefix}tail_consumers`);
    // Not `toBeGreaterThan(0)` on a merged list: the point is that *this*
    // block has one of its own. A tier relying on the top-level block gets a
    // wrangler warning and a Worker whose errors are persisted nowhere.
    expect(consumers).toHaveLength(1);
  });

  it.each(TIERS)("$label names the tail Worker that tier actually deploys", ({ prefix, suffix }) => {
    const [consumer] = arrayTables(api, `${prefix}tail_consumers`);
    const tailName = topLevelName(tail);
    expect(tailName).toBeDefined();
    expect(stringValue(consumer ?? "", "service")).toBe(`${tailName}${suffix}`);
  });
});

describe("the tail Worker's own config (wrangler.tail.toml)", () => {
  it("does not override `name` per environment, which is what makes the suffix rule true", () => {
    // If a future edit set `name` inside an `[env.*]` block, the deployed
    // script name would stop being `<name>-<env>` and the assertions above
    // would be checking a rule wrangler no longer follows.
    for (const block of ["env.preview", "env.production"]) {
      expect(stringValue(table(tail, block) ?? "", "name")).toBeUndefined();
    }
  });

  it.each(TIERS)("$label writes to the same database the API Worker reads", ({ prefix, database }) => {
    const [apiDb] = arrayTables(api, `${prefix}d1_databases`);
    const [tailDb] = arrayTables(tail, `${prefix}d1_databases`);

    expect(stringValue(apiDb ?? "", "database_name")).toBe(database);
    expect(stringValue(tailDb ?? "", "database_name")).toBe(database);
    // The id is the half that actually routes the writes; the name is a
    // label. Both are asserted because a mismatched pair is a config nobody
    // can read correctly afterwards.
    expect(stringValue(tailDb ?? "", "database_id")).toBe(stringValue(apiDb ?? "", "database_id"));
    expect(stringValue(tailDb ?? "", "binding")).toBe("DB");
  });

  it("binds nothing but D1", () => {
    // A tail consumer sees every log line the API Worker writes. It has no
    // business holding R2, KV, AI, email or an admin token, and the cheapest
    // way to keep that true is to notice the day one appears.
    for (const binding of ["r2_buckets", "kv_namespaces", "ratelimits", "send_email", "vectorize", "ai", "assets"]) {
      for (const { prefix } of TIERS) {
        expect(arrayTables(tail, `${prefix}${binding}`)).toHaveLength(0);
        expect(table(tail, `${prefix}${binding}`)).toBeUndefined();
      }
    }
  });

  it("does not claim the migrations directory — one config owns the ledger", () => {
    // `d1_migrations` is keyed on filename; two configs both able to apply
    // them is two ways to write that ledger. `wrangler.toml` owns it.
    // The assignment, not the word: this file's own header explains why it
    // has none, and a substring check would match the explanation.
    expect(/^\s*migrations_dir\s*=/m.test(tail)).toBe(false);
    expect(/^\s*migrations_dir\s*=/m.test(api)).toBe(true);
  });
});

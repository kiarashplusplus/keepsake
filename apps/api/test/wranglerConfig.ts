/**
 * A tiny `wrangler.toml` reader for the configuration guards.
 *
 * Two callers, two runtimes, one implementation on purpose:
 *
 * - `vitest.config.ts` runs in Node and uses it to *derive* the test
 *   fixture's `miniflare.assets.runWorkerFirst` from the deployed
 *   `[env.production.assets]` list, instead of restating it. Issue #195: the
 *   restated copy had already drifted — `/admin` was added to production and
 *   the mirror was not updated, so the suite was green about a path the
 *   deployed Worker treats differently.
 * - `test/robotsConfig.test.ts` runs inside workerd, which has no `node:fs`,
 *   and uses it on the `WRANGLER_TOML_TEXT` binding to assert the two agree.
 *
 * So it must stay dependency-free string-in/value-out: no `node:*`, no TOML
 * library (none is a dependency of this package, and adding one to the
 * Worker's devDependencies to read one key is not worth it). It understands
 * exactly the subset this repo's `wrangler.toml` uses.
 */

/** `run_worker_first` is either a blanket boolean or an explicit path list. */
export type RunWorkerFirst = boolean | string[];

/**
 * The lines belonging to a named table — `[env.production.assets]` — up to
 * the next table header. Comment lines are kept (they never start with `[`
 * at column zero in this file, and the value regexes ignore them anyway).
 */
function tableBody(tomlText: string, table: string): string | undefined {
  const lines = tomlText.split(/\r?\n/);
  const body: string[] = [];
  let inTable = false;
  let found = false;
  for (const line of lines) {
    const header = /^\s*\[\[?([^[\]]+)\]\]?\s*$/.exec(line);
    if (header) {
      inTable = (header[1] ?? "").trim() === table;
      found ||= inTable;
      continue;
    }
    if (inTable) body.push(line);
  }
  return found ? body.join("\n") : undefined;
}

/**
 * The `run_worker_first` value declared by `table`, or `undefined` when the
 * table exists but does not declare one. Throws when the table itself is
 * missing, because every caller is asking about a table it believes exists —
 * a rename should be loud, not silently "no list".
 */
export function readRunWorkerFirst(tomlText: string, table: string): RunWorkerFirst | undefined {
  const body = tableBody(tomlText, table);
  if (body === undefined) throw new Error(`wrangler.toml: no [${table}] table`);
  const match = /^\s*run_worker_first\s*=\s*(true|false|\[[^\]]*\])/m.exec(body);
  if (!match) return undefined;
  const raw = match[1] ?? "";
  if (raw === "true") return true;
  if (raw === "false") return false;
  return [...raw.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "");
}

/**
 * The deployed production list, as an array. Throws if it is missing or is
 * the boolean form: the test fixture derives its own `runWorkerFirst` from
 * this, and silently substituting `true` there would make every test pass
 * under a rule production does not use.
 */
export function productionRunWorkerFirst(tomlText: string): string[] {
  const value = readRunWorkerFirst(tomlText, "env.production.assets");
  if (!Array.isArray(value)) {
    throw new Error(
      `wrangler.toml: [env.production.assets] run_worker_first must be an explicit path list, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * A quoted string value declared by `table` — `not_found_handling`,
 * `html_handling` — or `undefined` when the table does not declare one.
 *
 * Same "throw on a missing table" rule as `readRunWorkerFirst`, for the same
 * reason: every caller is asking about a table it believes exists.
 */
export function readAssetsString(tomlText: string, table: string, key: string): string | undefined {
  const body = tableBody(tomlText, table);
  if (body === undefined) throw new Error(`wrangler.toml: no [${table}] table`);
  const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(body);
  return match?.[1];
}

/** Every `[assets]` table this file deploys, in the order they appear. */
export const ASSETS_TABLES = ["assets", "env.preview.assets", "env.production.assets"] as const;

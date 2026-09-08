/**
 * Estate bulk upload's per-batch ceilings must never exceed the contract's
 * caps, and the pilot must not be live in production.
 *
 * Modeled on `test/email-mode-config.test.ts` and `test/robotsConfig.test.ts`:
 * the real `wrangler.toml` text is asserted directly, via `WRANGLER_TOML_TEXT`
 * (injected by `vitest.config.ts`, read there in Node because the workers
 * runtime has no `node:fs`), rather than through whatever config vitest
 * happened to boot with. A runtime check can only ever see one environment's
 * bindings; this has to see all three blocks agree.
 *
 * See `packages/contracts/src/bulk.ts`'s comment on `MAX_BATCH_ITEMS` for why
 * the inequality matters: get it backwards and the failure lands on exactly
 * the person this feature exists to help — an operator raises
 * `BULK_MAX_ITEMS_PER_BATCH` past what `SubmitBatchInput` will ever accept, a
 * giver spends an evening photographing and describing 120 items against the
 * higher ceiling, and the submission 400s *after* the work, not before it.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_BATCH_ITEMS, MAX_BATCH_PHOTOS } from "@keepsake/contracts/bulk";

const wrangler = (env as unknown as { WRANGLER_TOML_TEXT: string }).WRANGLER_TOML_TEXT;

/**
 * The body of one single-bracket `[section]` table, up to (not including)
 * the next single-bracket header or the end of the file. `[[array.tables]]`
 * headers (two brackets — `[[d1_databases]]`, `[[ratelimits]]`, …) are
 * deliberately not a boundary: the same distinction
 * `tools/preflight/preflight.mjs`'s `parseToml` draws between `[section]` and
 * `[[array]]`, so a binding block sitting inside a vars section's byte range
 * never ends the slice early.
 */
function section(text: string, name: string): string {
  const escaped = name.replace(/\./g, "\\.");
  const header = new RegExp(`^\\[${escaped}\\]$`, "m").exec(text);
  if (!header) throw new Error(`wrangler.toml: no [${name}] section`);
  const rest = text.slice(header.index + header[0].length);
  const next = /^\[[^\]]+\]$/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** A `NAME = "value"` line's value, within an already-sliced section body. */
function stringVar(body: string, name: string): string {
  const match = new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m").exec(body);
  if (!match) throw new Error(`wrangler.toml: ${name} not found in this section`);
  return match[1] ?? "";
}

const ENV_SECTIONS = ["vars", "env.preview.vars", "env.production.vars"];

describe("estate bulk upload caps (wrangler.toml vs packages/contracts/src/bulk.ts)", () => {
  it.each(ENV_SECTIONS)("BULK_MAX_ITEMS_PER_BATCH does not exceed MAX_BATCH_ITEMS in [%s]", (name) => {
    const items = Number.parseInt(stringVar(section(wrangler, name), "BULK_MAX_ITEMS_PER_BATCH"), 10);
    expect(items).toBeLessThanOrEqual(MAX_BATCH_ITEMS);
  });

  it.each(ENV_SECTIONS)("BULK_MAX_PHOTOS_PER_BATCH does not exceed MAX_BATCH_PHOTOS in [%s]", (name) => {
    const photos = Number.parseInt(stringVar(section(wrangler, name), "BULK_MAX_PHOTOS_PER_BATCH"), 10);
    expect(photos).toBeLessThanOrEqual(MAX_BATCH_PHOTOS);
  });

  it('BULK_UPLOAD is "0" in [env.production.vars] — the pilot has not been approved for production', () => {
    expect(stringVar(section(wrangler, "env.production.vars"), "BULK_UPLOAD")).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// RL_BULK_UPLOAD — the burst binding that makes a 300-photo batch possible.
// ---------------------------------------------------------------------------
//
// Everything above this line checks numbers a person can eyeball in a diff.
// This binding is different: it lives inside three separate `[[ratelimits]]`
// array-tables (top-level, `[env.preview]`, `[env.production]`), so "missing
// from one block" or "silently drifted back toward RL_UPLOAD's number" is
// exactly the kind of thing a hand check misses on a file this long, and
// exactly what a `pnpm --filter @keepsake/api test` run has to catch on its
// own the way `env-parity` catches the same class of mistake for `[vars]`.

interface RatelimitValue {
  limit: number;
  period: number;
}

/**
 * The `limit`/`period` of one `name = "..."` entry inside a `[[<prefix>ratelimits]]`
 * array-table. `prefix` is `""` for the top-level block, or e.g.
 * `"env.preview."` for `[[env.preview.ratelimits]]` — mirroring
 * `section()`'s dotted-name handling above, but for a `[[...]]` array-table
 * rather than a `[...]` table, since `section()` itself only ever slices to
 * the next single-bracket header and a run of `[[ratelimits]]` blocks sits
 * between two of those with nothing to stop it early.
 */
function ratelimitBlock(text: string, prefix: string, name: string): RatelimitValue {
  const escapedPrefix = prefix.replace(/\./g, "\\.");
  const re = new RegExp(`\\[\\[${escapedPrefix}ratelimits\\]\\]\\n([\\s\\S]*?)(?=\\n\\[|$)`, "g");
  for (const match of text.matchAll(re)) {
    const body = match[1] ?? "";
    if (new RegExp(`^name\\s*=\\s*"${name}"$`, "m").exec(body) === null) continue;
    const limit = /^simple\s*=\s*\{[^}]*\blimit\s*=\s*(\d+)/m.exec(body);
    const period = /^simple\s*=\s*\{[^}]*\bperiod\s*=\s*(\d+)/m.exec(body);
    if (!limit || !period) throw new Error(`wrangler.toml: [[${prefix}ratelimits]] "${name}" has no simple = { limit, period }`);
    return { limit: Number(limit[1]), period: Number(period[1]) };
  }
  throw new Error(`wrangler.toml: no [[${prefix}ratelimits]] block named "${name}"`);
}

const RATELIMIT_BLOCKS = [
  { label: "[[ratelimits]]", prefix: "" },
  { label: "[[env.preview.ratelimits]]", prefix: "env.preview." },
  { label: "[[env.production.ratelimits]]", prefix: "env.production." },
];

describe("estate bulk upload photo burst binding (RL_BULK_UPLOAD in wrangler.toml)", () => {
  it.each(RATELIMIT_BLOCKS)("is declared in $label, on a period Wrangler actually accepts (10s or 60s)", ({ prefix }) => {
    const { period } = ratelimitBlock(wrangler, prefix, "RL_BULK_UPLOAD");
    expect([10, 60]).toContain(period);
  });

  it.each(RATELIMIT_BLOCKS)("in $label, RL_UPLOAD itself is untouched at 10/60s — the give flow's binding, not this feature's to change", ({ prefix }) => {
    expect(ratelimitBlock(wrangler, prefix, "RL_UPLOAD")).toEqual({ limit: 10, period: 60 });
  });

  it.each(RATELIMIT_BLOCKS)("in $label, RL_BULK_UPLOAD allows a strictly higher sustained rate than RL_UPLOAD", ({ prefix }) => {
    const bulkUpload = ratelimitBlock(wrangler, prefix, "RL_BULK_UPLOAD");
    const giveFlowUpload = ratelimitBlock(wrangler, prefix, "RL_UPLOAD");
    // A binding at or below RL_UPLOAD's own rate would silently reintroduce
    // the 30+-minute forced wait this binding exists to remove — see
    // `wrangler.toml`'s own comment on `RL_BULK_UPLOAD` for the "why 300
    // photos is currently impossible" arithmetic this guards against
    // regressing.
    expect(bulkUpload.limit / bulkUpload.period).toBeGreaterThan(giveFlowUpload.limit / giveFlowUpload.period);
  });

  it.each(RATELIMIT_BLOCKS)("in $label, a full MAX_BATCH_PHOTOS batch clears this binding's own rate well inside 10 minutes", ({ prefix }) => {
    const { limit, period } = ratelimitBlock(wrangler, prefix, "RL_BULK_UPLOAD");
    // Treats the binding as a sustained rate (limit per period, back to
    // back) — the same simplification `wrangler.toml`'s comment on this
    // binding makes explicit, and generous in the guard's favor since the
    // real binding is bursty (documented, and separately, to let a burst of
    // concurrent requests through faster than a strict steady rate would).
    // This is the numeric form of the acceptance gate this binding exists
    // to satisfy: "a 100-item, 300-photo batch can be prepared and
    // submitted" without 30+ minutes of forced waiting.
    const minutesForFullBatch = (MAX_BATCH_PHOTOS / limit) * (period / 60);
    expect(minutesForFullBatch).toBeLessThanOrEqual(10);
  });

  it("RL_BULK_UPLOAD is the same limit/period in every env block — restated identically, not drifted apart", () => {
    const [top, preview, production] = RATELIMIT_BLOCKS.map(({ prefix }) => ratelimitBlock(wrangler, prefix, "RL_BULK_UPLOAD"));
    expect(preview).toEqual(top);
    expect(production).toEqual(top);
  });
});

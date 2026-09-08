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

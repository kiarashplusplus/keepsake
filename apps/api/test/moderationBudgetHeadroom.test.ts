/**
 * Estate bulk upload's moderation-budget ceilings must actually leave room
 * for the traffic they're sized against — not just be "some number bigger
 * than the old one".
 *
 * `BULK_UPLOAD` is `"1"` in both `[env.preview.vars]` and, since 2026-09-08,
 * `[env.production.vars]` too (`test/bulkCaps.test.ts` guards that half).
 * This guards the other half, in both blocks: that
 * `MOD_TEXT_DAILY_BUDGET`/`MOD_IMAGE_DAILY_BUDGET` actually give a bulk
 * owner's worst realistic day of moderation calls comfortable headroom
 * inside the *general* pool (`dailyLimit` minus `moderation/pipeline.ts`'s
 * `RESERVED_FLOOR_RATIO` slice) — the pool bulk traffic actually draws from,
 * since neither the create-time call (`bulk/submit.ts`) nor the retry cron
 * ever carries a `clientIP` and so can never reach the reserved floor itself
 * (see `cron/moderationRetry.ts`'s own comment on that).
 *
 * "Worst realistic day" is one owner spending their entire daily allowance
 * (`BULK_OWNER_DAILY_ITEMS`/`BULK_OWNER_DAILY_PHOTOS` — the ceiling that
 * survives a fresh batch or a renewed grant, `src/env.ts`) and every one of
 * those calls needing all `MAX_ATTEMPTS` (3, `moderation/pipeline.ts`) real
 * attempts before landing — an AI-outage day, not a normal one, and the
 * shape of day this ceiling exists to survive. Modeled on
 * `test/bulkCaps.test.ts`: the real `wrangler.toml` text is asserted
 * directly via `WRANGLER_TOML_TEXT` (injected by `vitest.config.ts`), so
 * this fails the moment someone lowers the number back down rather than only
 * when someone runs a real pilot batch and watches it stall.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_BATCH_ITEMS, MAX_BATCH_PHOTOS } from "@keepsake/contracts/bulk";
import { DEFAULT_BULK_OWNER_DAILY_ITEMS, DEFAULT_BULK_OWNER_DAILY_PHOTOS } from "../src/env.js";
import { MODERATED_PHOTO_VARIANTS } from "../src/moderation/image.js";

const wrangler = (env as unknown as { WRANGLER_TOML_TEXT: string }).WRANGLER_TOML_TEXT;

// Same slice `test/bulkCaps.test.ts` cuts, restated here rather than shared
// so this file has no import dependency on another test file.
function section(text: string, name: string): string {
  const escaped = name.replace(/\./g, "\\.");
  const header = new RegExp(`^\\[${escaped}\\]$`, "m").exec(text);
  if (!header) throw new Error(`wrangler.toml: no [${name}] section`);
  const rest = text.slice(header.index + header[0].length);
  const next = /^\[[^\]]+\]$/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

function numberVar(body: string, name: string): number {
  const match = new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m").exec(body);
  if (!match) throw new Error(`wrangler.toml: ${name} not found in this section`);
  return Number.parseInt(match[1] ?? "", 10);
}

// Mirrors `moderation/pipeline.ts`'s own private constants — not imported
// (neither is exported, and this file doesn't own pipeline.ts) but pinned
// here so a change to either number is a visible diff in this test alongside
// whatever prompted it, rather than a silent mismatch.
const RESERVED_FLOOR_RATIO = 0.1;
const MAX_ATTEMPTS = 3;

/** No caller of this budget check that bulk traffic ever reaches carries a
 * `clientIP` (`bulk/submit.ts`'s create-time call and every cron retry both
 * omit it), so bulk consumption is confined to the general pool for its
 * entire life — it can never draw on the reserved floor the way a fresh
 * ordinary create/edit call can. */
function generalPool(dailyLimit: number): number {
  return dailyLimit * (1 - RESERVED_FLOOR_RATIO);
}

describe.each(["env.preview.vars", "env.production.vars"])("estate bulk-upload budget headroom (wrangler.toml [%s])", (sectionName) => {
  const block = section(wrangler, sectionName);
  const textLimit = numberVar(block, "MOD_TEXT_DAILY_BUDGET");
  const imageLimit = numberVar(block, "MOD_IMAGE_DAILY_BUDGET");

  it("a single full pilot batch (100 items / 300 photos) costs well under the text general pool", () => {
    const batchTextCalls = MAX_BATCH_ITEMS; // one text check per listing
    expect(batchTextCalls).toBeLessThan(generalPool(textLimit) * 0.2);
  });

  it("a single full pilot batch (100 items / 300 photos) costs well under the image general pool", () => {
    const batchImageCalls = MAX_BATCH_PHOTOS * MODERATED_PHOTO_VARIANTS.length;
    expect(batchImageCalls).toBeLessThan(generalPool(imageLimit) * 0.2);
  });

  it("one owner's worst-case day (full daily allowance, every item needing all 3 attempts) stays under a fifth of the text general pool", () => {
    const worstCaseTextCalls = DEFAULT_BULK_OWNER_DAILY_ITEMS * MAX_ATTEMPTS;
    expect(worstCaseTextCalls).toBeLessThan(generalPool(textLimit) * 0.2);
  });

  it("one owner's worst-case day (full daily allowance, every item needing all 3 attempts) stays under a fifth of the image general pool", () => {
    const worstCaseImageCalls = DEFAULT_BULK_OWNER_DAILY_PHOTOS * MODERATED_PHOTO_VARIANTS.length * MAX_ATTEMPTS;
    expect(worstCaseImageCalls).toBeLessThan(generalPool(imageLimit) * 0.2);
  });
});

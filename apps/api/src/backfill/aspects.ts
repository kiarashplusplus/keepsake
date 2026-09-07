/**
 * Issue #37: populate `listing_aspects` for listings that existed before
 * #36 shipped, by running the same suggestion path
 * (`src/suggest/suggest.ts`'s `suggestFromPhoto`) against each one's cover
 * photo — one batch per call, driven by `POST /api/admin/backfill-aspects`
 * (`routes/admin.ts`).
 *
 * Three requirements from the issue, and how this satisfies each:
 *
 * 1. **Respects the same moderation budget constraints as live traffic.**
 *    Every listing costs one `checkAndBump({ kind: "suggest" })` call
 *    against the exact same `SUGGEST_DAILY_BUDGET` global counter
 *    `POST /api/photos/:id/suggest` draws from — global-only (no
 *    `clientIP`/`ipDailyLimit`), since a per-IP ceiling makes no sense for
 *    one admin-triggered process and would only make the backfill slower
 *    for no safety benefit. The moment the shared counter is exhausted,
 *    this stops rather than pushing through — a batch mid-run under a
 *    tight budget still can't ever push the combined (live + backfill)
 *    total past the same ceiling a real giver's autofill call would hit.
 *
 * 2. **Idempotent / safe to re-run.** A listing is only ever a candidate
 *    while `aspects_backfilled_at IS NULL` *and* it has no `listing_aspects`
 *    rows yet — so a listing that already has real aspects (e.g. created
 *    after #36, through the live give flow) is skipped for free, and a
 *    listing this job has already attempted is never attempted twice.
 *
 * 3. **Resumable.** Each call processes at most `limit` listings and
 *    returns `remaining`; there is no in-memory state between calls, so a
 *    call can be repeated (after a deploy, a crashed process, a new
 *    session, whatever) and it always picks up exactly where the last one
 *    left off, driven entirely by durable D1 state.
 *
 * The genuinely tricky part is requirement 2 combined with the prompt's own
 * behavior: `suggest/prompts.ts` explicitly tells the model to return an
 * *empty* `aspects` array rather than guess at something it isn't sure of —
 * "the right number of visible aspects for a given photo is often zero".
 * That means "this listing has zero aspects because the model looked and
 * found nothing" and "this listing has zero aspects because nothing has
 * ever looked" are both, structurally, zero rows in `listing_aspects` — and
 * confusing the two would mean re-spending suggest budget on the exact same
 * listing every single run, forever, which fails requirements 1-3 all at
 * once (never converges, never idempotent, wastes the shared budget).
 * `listings.aspects_backfilled_at` (migration 0009) is the fix: stamped the
 * moment this job has attempted a listing, independent of whether that
 * attempt produced any aspects.
 */
import type { Aspect } from "@keepsake/contracts/listing";
import type { Env } from "../env.js";
import { parseIntVar } from "../env.js";
import { checkAndBump } from "../moderation/budget.js";
import { suggestFromPhoto } from "../suggest/suggest.js";
import { replaceListingAspects } from "../lib/listingsDb.js";
import { reembedListing } from "../search/reembed.js";

// Mirrors routes/photos.ts's own DEFAULT_SUGGEST_DAILY_BUDGET exactly — kept
// as a second literal rather than an import because that constant isn't
// exported (routes/photos.ts has no reason to export route-local defaults),
// and this is the same "parseIntVar with a fallback" pattern used
// everywhere else in this codebase a wrangler.toml var might be unset.
const DEFAULT_SUGGEST_DAILY_BUDGET = 1000;

/** SQL condition shared by the candidate-selection query and the
 * `remaining` count below, so the two can never quietly drift apart (e.g.
 * "remaining" counting a listing the batch query itself would never touch,
 * such as one with no photos at all — see `HAS_COVER_PHOTO` below). */
const IS_ASPECTS_BACKFILL_CANDIDATE = `
  l.aspects_backfilled_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM listing_aspects la WHERE la.listing_id = l.id)
  AND EXISTS (SELECT 1 FROM photos p2 WHERE p2.listing_id = l.id AND p2.position = 0)
`;

interface BackfillCandidateRow {
  id: string;
  r2_key_thumb: string;
  content_type: string;
}

export interface AspectsBackfillBatchResult {
  processed: number;
  withAspects: number;
  withoutAspects: number;
  failed: number;
  budgetExhausted: boolean;
  remaining: number;
}

async function fetchRemainingCount(env: Env): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM listings l WHERE ${IS_ASPECTS_BACKFILL_CANDIDATE}`).first<{
    count: number;
  }>();
  return row?.count ?? 0;
}

async function markAttempted(env: Env, listingId: string, now: number): Promise<void> {
  await env.DB.prepare("UPDATE listings SET aspects_backfilled_at = ? WHERE id = ?").bind(now, listingId).run();
}

async function persistOutcome(env: Env, listingId: string, aspects: Aspect[] | null): Promise<"with_aspects" | "without_aspects"> {
  if (aspects === null || aspects.length === 0) {
    return "without_aspects";
  }
  await replaceListingAspects(env, listingId, aspects);
  return "with_aspects";
}

/**
 * Runs one batch of the backfill: up to `limit` aspect-less listings, each
 * checked against the live suggest budget before its vision call. Never
 * throws — a single row's unexpected failure is counted and skipped, not
 * allowed to abandon the rest of the batch (a job meant to run for a while
 * unattended must not wedge on one bad row).
 */
export async function runAspectsBackfillBatch(env: Env, limit: number): Promise<AspectsBackfillBatchResult> {
  const { results: candidates } = await env.DB.prepare(
    `SELECT l.id AS id, p.r2_key_thumb AS r2_key_thumb, p.content_type AS content_type
     FROM listings l
     JOIN photos p ON p.listing_id = l.id AND p.position = 0
     WHERE ${IS_ASPECTS_BACKFILL_CANDIDATE}
     ORDER BY l.created_at
     LIMIT ?`,
  )
    .bind(limit)
    .all<BackfillCandidateRow>();

  const dailyLimit = parseIntVar("SUGGEST_DAILY_BUDGET", env.SUGGEST_DAILY_BUDGET, DEFAULT_SUGGEST_DAILY_BUDGET);

  let processed = 0;
  let withAspects = 0;
  let withoutAspects = 0;
  let failed = 0;
  let budgetExhausted = false;

  for (const row of candidates) {
    const budget = await checkAndBump(env.KV, { kind: "suggest", dailyLimit });
    if (!budget.allowed) {
      budgetExhausted = true;
      break;
    }

    try {
      const result = await suggestFromPhoto(env, { r2_key_thumb: row.r2_key_thumb, content_type: row.content_type });
      const outcome = await persistOutcome(env, row.id, result.suggestion ? result.suggestion.aspects : null);
      if (outcome === "with_aspects") withAspects += 1;
      else withoutAspects += 1;
    } catch (err) {
      // `suggestFromPhoto` doesn't throw by contract (every failure mode
      // returns `{ suggestion: null, reason }`), but this loop can't rely
      // on that promise holding forever — an unexpected throw here must
      // still let the batch (and the stamp below) proceed, or one bad row
      // would wedge every future run behind it.
      failed += 1;
      console.error("aspectsBackfill: unexpected error", {
        listingId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Re-embed for semantic search (#38) — the write this listing would
    // otherwise never get. `reembedListing`'s own doc comment always said
    // this job should call it; #37 landed first, so nothing ever did, and
    // an aspect the backfill wrote stayed invisible to vector search until
    // someone edited the listing by hand. It is the only path that reaches
    // listings created before the feature existed, which today is every
    // listing in production.
    //
    // Run for *every* attempted row, not only the ones that gained an
    // aspect: the vector is built from title + story + aspects, so a
    // legitimately aspect-less listing is exactly the #40 case that most
    // needs to be findable some other way. `reembedListing` is itself
    // gated on `SEMANTIC_SEARCH` and on `EMBED_DAILY_BUDGET`, so with the
    // flag off this costs nothing and spends nothing.
    //
    // Its own contract is "never throws", but this loop cannot lean on that
    // promise holding forever any more than it leans on `suggestFromPhoto`'s
    // — and an embedding failure must not be counted as an aspects failure,
    // since the aspects were already persisted above.
    try {
      await reembedListing(env, row.id);
    } catch (err) {
      console.error("aspectsBackfill: re-embed failed", {
        listingId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Stamped unconditionally — success, a legitimate zero-aspect result,
    // or a caught failure all count as "attempted" (see this module's
    // header comment on why that distinction is the whole point).
    await markAttempted(env, row.id, Date.now());
    processed += 1;
  }

  return {
    processed,
    withAspects,
    withoutAspects,
    failed,
    budgetExhausted,
    remaining: await fetchRemainingCount(env),
  };
}

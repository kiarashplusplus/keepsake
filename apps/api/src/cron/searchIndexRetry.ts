/**
 * Issue #208: the retry half. `listings.vector_indexed_at` (#180) records
 * that a listing has no vector for its current text — never embedded, or
 * invalidated by a re-embed that failed — and until this job nothing ever
 * looked at that fact again. A listing whose embed failed once stayed
 * un-indexed forever, its ranking quietly degraded, and the only way back was
 * for its owner to happen to edit it.
 *
 * Deliberately narrow, in three ways:
 *
 *  - **`approved` only.** Those are the listings a stranger can find, so
 *    those are the ones a missing vector actually costs. A `pending` listing
 *    with no vector yet is the pipeline working, and re-embedding it here
 *    would spend `EMBED_DAILY_BUDGET` on text a human may still reject.
 *  - **Hourly, five at a time.** `reembedListing` spends one Workers AI call
 *    and one `EMBED_DAILY_BUDGET` increment per listing, so the worst case
 *    this job can cost is 120 embeds a day against a budget of 2000 — small
 *    enough that a backlog can never crowd out the create/edit paths, which
 *    are the ones a person is waiting on. `moderationRetry` runs every five
 *    minutes because a listing stuck in `pending` is invisible to everyone;
 *    an un-indexed listing is merely ranked worse, and is still findable
 *    through FTS (#180), so it does not deserve the same cadence.
 *  - **Newest first.** A fresh failure is the one most likely to be
 *    transient — a Workers AI blip, an exhausted budget that resets at
 *    midnight — and the one whose giver is still watching. The honest cost:
 *    a listing that fails *permanently* (text the model refuses, a Vectorize
 *    id it will not take) sits at the back of this queue for as long as newer
 *    failures keep arriving. That is what the Observatory's
 *    `oldest_unindexed_age_ms` is for — a permanent failure shows up there as
 *    an age that keeps growing, which is a bug report, not a retry candidate.
 *
 * `reembedListing` never throws and records its own outcome on every exit,
 * so this job needs no error handling of its own: a run that fixes nothing
 * leaves exactly the rows it found, and the next hour tries again.
 */
import type { Env } from "../env.js";
import { semanticSearchEnabled } from "../env.js";
import { reembedListing } from "../search/reembed.js";

/** Per run. See the header for why this is small rather than "drain it". */
const BATCH = 5;

export async function searchIndexRetry(env: Env): Promise<void> {
  // With the kill switch off, `reembedListing` returns before doing anything
  // and every listing reads as un-indexed — so this would select five rows an
  // hour, forever, and change nothing. Checked here as well as there so the
  // log line says why the job did nothing.
  if (!semanticSearchEnabled(env)) {
    console.log("searchIndexRetry: SEMANTIC_SEARCH is off, nothing to do", { environment: env.ENVIRONMENT });
    return;
  }

  const { results } = await env.DB.prepare(
    `SELECT id FROM listings
      WHERE status = 'approved' AND vector_indexed_at IS NULL
      ORDER BY updated_at DESC LIMIT ?`,
  )
    .bind(BATCH)
    .all<{ id: string }>();

  for (const row of results) {
    await reembedListing(env, row.id);
  }

  // `attempted` is not `succeeded`: `reembedListing` swallows its own
  // failures by design (a listing write must never 500 because an embedding
  // failed), so the honest measure of whether this job is working is the
  // Observatory's un-indexed count going down, not this line. Logged anyway
  // because a run that attempts zero every hour while that count sits at
  // forty means the *selection* is wrong, which this line can show and that
  // count cannot.
  const remaining = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM listings WHERE status = 'approved' AND vector_indexed_at IS NULL",
  ).first<{ n: number }>();

  console.log("searchIndexRetry: done", {
    environment: env.ENVIRONMENT,
    attempted: results.length,
    remainingUnindexed: remaining?.n ?? null,
  });
}

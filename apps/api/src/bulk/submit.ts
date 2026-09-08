/**
 * The durable submission runner: turns an estate bulk-upload batch's
 * reviewed drafts into ordinary listings.
 *
 * `startSubmission` is the synchronous half — it happens inline in
 * `POST /api/bulk/batches/:id/submit` (owned by `routes/bulk.ts`), resolves
 * exactly which draft items are being published and at which revision, and
 * records a `bulk_operations` row idempotent on `(owner_id, batch_id, kind,
 * op_key)`. `runBulkOperation` is the durable half — it does the actual
 * publishing work, a few items at a time, and is safe to call again after a
 * crash, a Worker eviction, or two overlapping cron ticks.
 *
 * ## Why one listing at a time, through `createListingForOwner`
 *
 * Nothing here writes a `listings` row itself. `src/listings/create.ts` is
 * the one implementation of "create a listing", shared with the give flow's
 * `POST /api/listings` — see that module's own header for why a second copy
 * would drift. Its `claim` argument is exactly the bulk runner's concurrency
 * story: the claim UPDATE only fires while the draft item still has no
 * listing and is still at the revision the giver reviewed, and the guarded
 * listing INSERT only fires if this call won that claim. Two overlapping
 * runs of the same operation — deliberate concurrency (finding #1 below) or
 * a crash-and-resume (#2) — can both attempt the same item, and at most one
 * of them ends up with a listing.
 *
 * ## Why the payload hash exists
 *
 * `op_key` alone is not enough to make a submission retry-safe. A caller
 * that retries "submit these 42 items" with the same key after silently
 * dropping three of them from the request would otherwise resolve to the
 * *original* operation and publish the three it meant to withdraw — same
 * key, different intent, silently doing the new thing under the old key's
 * identity. `payload_hash` is what tells those two cases apart: identical
 * hash is a genuine retry (replay the existing operation); different hash
 * under the same key is a caller bug, answered 409 rather than guessed at.
 */
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { captureException } from "@keepsake/observability/capture";
import type { ErrorCode } from "@keepsake/contracts/common";
import type { SubmitBatchInput, BulkOperationSummary, BulkOperationStatus } from "@keepsake/contracts/bulk";
import { CreateListingInput } from "@keepsake/contracts/listing";
import type { Country, PostalLookup } from "@keepsake/contracts/geo";
import type { Env } from "../env.js";
import { sha256Hex } from "../lib/digest.js";
import { ulid } from "../lib/ids.js";
import { aspectsContainContactInfo, ASPECT_CONTACT_INFO_MESSAGE, buildListingCreateStatements } from "../listings/create.js";
import { moderateListing } from "../moderation/pipeline.js";

// ---------------------------------------------------------------------------
// startSubmission
// ---------------------------------------------------------------------------

export interface StartSubmissionArgs {
  ownerId: string;
  batchId: string;
  input: SubmitBatchInput;
  now?: number;
}

export type StartSubmissionResult =
  | { ok: true; operation: BulkOperationSummary; replayed: boolean }
  | { ok: false; code: ErrorCode; message: string; status: ContentfulStatusCode };

interface BatchRow {
  id: string;
  owner_id: string;
}

interface ItemKeyRow {
  id: string;
  client_item_id: string;
  revision: number;
}

/** What `bulk_operations.selection_json` holds — pinned at accept time so
 * the runner never has to re-resolve `client_item_id`s later, and so an item
 * edited after submission still publishes the exact revision the giver
 * reviewed (or is refused by `createListingForOwner`'s claim, not silently
 * republished with the new content). */
export interface SelectionEntry {
  client_item_id: string;
  item_id: string;
  revision: number;
}

interface OperationRow {
  id: string;
  owner_id: string;
  batch_id: string;
  op_key: string;
  payload_hash: string;
  selection_json: string;
  status: BulkOperationStatus;
  cursor: number;
  total: number;
  succeeded: number;
  failed: number;
  attempts: number;
  lease_until: number | null;
  next_attempt_at: number;
  age_attested_at: number;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

function toSummary(op: OperationRow): BulkOperationSummary {
  return {
    id: op.id,
    batch_id: op.batch_id,
    kind: "submit",
    status: op.status,
    total: op.total,
    succeeded: op.succeeded,
    failed: op.failed,
    created_at: op.created_at,
    updated_at: op.updated_at,
    finished_at: op.finished_at,
  };
}

/**
 * Canonical serialization of a selection: sorted by `client_item_id`, each
 * entry rendered as `client_item_id:revision`, one per line. Deterministic
 * regardless of the order the caller listed items in — two requests naming
 * the same items at the same revisions in a different order must hash
 * identically, or a client that merely re-orders its own array would look
 * like a different payload under the same `op_key`.
 */
function canonicalSelection(items: readonly { client_item_id: string; revision: number }[]): string {
  return [...items]
    .sort((a, b) => (a.client_item_id < b.client_item_id ? -1 : a.client_item_id > b.client_item_id ? 1 : 0))
    .map((item) => `${item.client_item_id}:${item.revision}`)
    .join("\n");
}

/**
 * Resolves a submission's named items against this batch, records a
 * `bulk_operations` row (idempotent on `op_key`), and marks the batch and its
 * items as submitting. Performs no publishing work itself — that is
 * `runBulkOperation`'s job, driven by `cron/bulkRunner.ts` (and, in the
 * future, an eager first attempt right after accept).
 */
export async function startSubmission(env: Env, args: StartSubmissionArgs): Promise<StartSubmissionResult> {
  const { ownerId, batchId, input } = args;
  const now = args.now ?? Date.now();

  const batch = await env.DB.prepare(`SELECT id, owner_id FROM upload_batches WHERE id = ? AND owner_id = ?`)
    .bind(batchId, ownerId)
    .first<BatchRow>();
  if (!batch) {
    return { ok: false, code: "not_found", message: "Batch not found.", status: 404 };
  }

  // Resolve every named client_item_id to its current row and revision.
  // Missing entirely and moved-since-reviewed are the same class of problem
  // from the caller's side — "what you reviewed is not what's here now" —
  // and are answered together, below, rather than as two different errors.
  const clientIds = input.items.map((item) => item.client_item_id);
  const placeholders = clientIds.map(() => "?").join(",");
  const { results: rows } = await env.DB.prepare(
    `SELECT id, client_item_id, revision FROM upload_batch_items WHERE batch_id = ? AND client_item_id IN (${placeholders})`,
  )
    .bind(batchId, ...clientIds)
    .all<ItemKeyRow>();
  const byClientId = new Map(rows.map((row) => [row.client_item_id, row]));

  const moved: string[] = [];
  const resolved: SelectionEntry[] = [];
  for (const selected of input.items) {
    const row = byClientId.get(selected.client_item_id);
    if (!row || row.revision !== selected.revision) {
      moved.push(selected.client_item_id);
      continue;
    }
    resolved.push({ client_item_id: selected.client_item_id, item_id: row.id, revision: selected.revision });
  }

  if (moved.length > 0) {
    return {
      ok: false,
      code: "conflict",
      message: `These items changed since you reviewed them: ${moved.join(", ")}.`,
      status: 409,
    };
  }

  const payloadHash = await sha256Hex(canonicalSelection(input.items));
  const candidateOperationId = ulid(now);
  const selectionJson = JSON.stringify(resolved);

  // The idempotent insert. `DO NOTHING` on the unique `(owner_id, batch_id,
  // kind, op_key)` index means a caller retrying the exact same request (or
  // a genuinely concurrent double-submit) never gets a second operation row
  // — see the re-select immediately below, which is what tells a fresh
  // insert apart from a replay.
  await env.DB.prepare(
    `INSERT INTO bulk_operations
       (id, owner_id, batch_id, kind, op_key, payload_hash, selection_json,
        status, cursor, total, succeeded, failed, attempts, lease_until,
        next_attempt_at, age_attested_at, created_at, updated_at, finished_at)
     VALUES (?, ?, ?, 'submit', ?, ?, ?, 'queued', 0, ?, 0, 0, 0, NULL, ?, ?, ?, ?, NULL)
     ON CONFLICT(owner_id, batch_id, kind, op_key) DO NOTHING`,
  )
    .bind(candidateOperationId, ownerId, batchId, input.op_key, payloadHash, selectionJson, resolved.length, now, now, now, now)
    .run();

  const existing = await env.DB.prepare(
    `SELECT * FROM bulk_operations WHERE owner_id = ? AND batch_id = ? AND kind = 'submit' AND op_key = ?`,
  )
    .bind(ownerId, batchId, input.op_key)
    .first<OperationRow>();
  if (!existing) {
    // Unreachable outside a D1 outage between the insert and the re-select —
    // this call just wrote the row (or a concurrent one did). Named
    // "internal" rather than assumed impossible, per the house rule that the
    // unexpected-error boundary is the only honest code for it.
    return { ok: false, code: "internal", message: "Something went wrong recording the submission. Please try again.", status: 500 };
  }

  const replayed = existing.id !== candidateOperationId;

  if (replayed && existing.payload_hash !== payloadHash) {
    // Same key, different payload: a caller bug (or a client that reused an
    // op_key after changing its mind about the selection), not a retry.
    // Doing the new thing under the old key's identity would silently
    // publish a different set of items than the one the giver last saw
    // accepted — refused outright instead.
    return {
      ok: false,
      code: "conflict",
      message: "This submission key was already used for a different selection.",
      status: 409,
    };
  }

  if (!replayed) {
    // Only on the genuinely new operation — a replay must not disturb items
    // the runner has already advanced past `queued` (submitted, failed).
    const itemIds = resolved.map((entry) => entry.item_id);
    if (itemIds.length > 0) {
      const itemPlaceholders = itemIds.map(() => "?").join(",");
      await env.DB.prepare(`UPDATE upload_batch_items SET state = 'queued', updated_at = ? WHERE id IN (${itemPlaceholders})`)
        .bind(now, ...itemIds)
        .run();
    }
    await env.DB.prepare(`UPDATE upload_batches SET state = 'submitting', updated_at = ? WHERE id = ?`).bind(now, batchId).run();
  }

  return { ok: true, operation: toSummary(existing), replayed };
}

// ---------------------------------------------------------------------------
// runBulkOperation
// ---------------------------------------------------------------------------

/** Bounded so `runCron` (`index.ts`), which awaits a cron job to completion
 * with no `ExecutionContext` trick available to it, always resolves quickly
 * — and so one estate's 100-item batch cannot spend the day's moderation
 * budget (each item below calls `moderateListing` once) in a single
 * invocation. */
export const ITEMS_PER_INVOCATION = 5;

const LEASE_MS = 120 * 1000;
const BASE_BACKOFF_MS = 30 * 1000;
const MAX_BACKOFF_MS = 10 * 60 * 1000;

function backoffMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 5));
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** exponent);
}

/**
 * Runs `buildListingCreateStatements`'s claim-path statements as one batch,
 * with `PRAGMA defer_foreign_keys = ON` prepended — everything else about
 * the statements is exactly what that function built, untouched.
 *
 * Why this exists instead of calling `createListingForOwner` directly: the
 * claim path's *first* statement sets `upload_batch_items.listing_id` to the
 * id the *second* statement is about to insert — deliberately, so a release
 * statement later in the same batch can put it back to `NULL` if the
 * insert's own guard declines (see `listings/create.ts`'s header on why
 * there is no compensating delete instead). SQLite checks a non-deferrable
 * foreign key immediately after the statement that violates it, not at
 * commit, so without deferring, that first UPDATE fails before the INSERT it
 * is paired with ever runs — on every claimed create, whether the guard
 * would have accepted or declined it, because the referenced row simply
 * doesn't exist yet at that point in the batch. Deferring to commit is
 * exactly what the claim → insert → (maybe) release shape already assumes:
 * by the time the whole batch commits, `listing_id` is either a real row
 * (the insert succeeded) or back to `NULL` (the release fired), and the
 * constraint holds either way. Confirmed directly against this runtime's D1
 * emulation (`PRAGMA defer_foreign_keys = ON` as the batch's first
 * statement is what turns a `FOREIGN KEY constraint failed` on the claim
 * UPDATE into a clean pass or a clean, guard-declined release).
 */
async function createClaimedListing(
  env: Env,
  args: Parameters<typeof buildListingCreateStatements>[1] & { claim: NonNullable<Parameters<typeof buildListingCreateStatements>[1]["claim"]> },
): Promise<boolean> {
  const { statements, insertResultIndex } = buildListingCreateStatements(env, args);
  const results = await env.DB.batch([env.DB.prepare("PRAGMA defer_foreign_keys = ON"), ...statements]);
  const insertResult = results[insertResultIndex + 1];
  return (insertResult?.meta?.changes ?? 0) > 0;
}

/** A date of birth that satisfies `DateOfBirthSchema` (real calendar date,
 * not in the future, at least `MINIMUM_AGE`, not implausibly old) so
 * `CreateListingInput.safeParse` below runs the same validation the give
 * flow runs — see this file's header and issue #64. The real attestation
 * already happened once, at `startSubmission` time, and is what
 * `bulk_operations.age_attested_at` records; this value is read by the
 * schema for its pass/fail verdict and then discarded like any other
 * `date_of_birth`, never reaching a stored column (see
 * `buildListingCreateStatements`'s claim branch, which stamps
 * `listings.age_attested_at` from its own `now` unconditionally). */
function placeholderDateOfBirth(now: number): string {
  const date = new Date(now);
  date.setUTCFullYear(date.getUTCFullYear() - 40);
  return date.toISOString().slice(0, 10);
}

interface DraftItemRow {
  id: string;
  title: string | null;
  story: string | null;
  category: string | null;
  aspects_json: string | null;
}

interface BatchGeoRow {
  id: string;
  owner_id: string;
  country: string;
  postal_code: string;
  place_name: string;
  admin1: string | null;
  lat: number;
  lng: number;
}

async function markItemFailed(env: Env, itemId: string, code: string, detail: string, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE upload_batch_items SET state = 'failed', failure_code = ?, failure_detail = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(code, detail, now, itemId)
    .run();
}

type ItemOutcome = "succeeded" | "failed";

/**
 * Assembles one draft item into a real `CreateListingInput`, runs the one
 * real validation (never a restated copy of a publishing rule — see this
 * file's header and `listings/create.ts`'s own comment on `DraftItemFields`),
 * and publishes it through the shared create path.
 */
async function processItem(env: Env, op: OperationRow, batch: BatchGeoRow, entry: SelectionEntry, now: number): Promise<ItemOutcome> {
  const item = await env.DB.prepare(
    `SELECT id, title, story, category, aspects_json FROM upload_batch_items WHERE id = ? AND batch_id = ?`,
  )
    .bind(entry.item_id, op.batch_id)
    .first<DraftItemRow>();

  if (!item) {
    // The item's row is gone — only possible via `ON DELETE CASCADE` off a
    // deleted batch/listing, which shouldn't happen mid-operation. Nothing to
    // write a failure onto; log and move on rather than throw, so the rest of
    // the selection still gets its turn.
    console.error("bulkRunner: selected item is missing", { operationId: op.id, itemId: entry.item_id });
    return "failed";
  }

  const { results: photoRows } = await env.DB.prepare(
    `SELECT photo_id FROM upload_batch_photos WHERE item_id = ? ORDER BY position ASC`,
  )
    .bind(entry.item_id)
    .all<{ photo_id: string }>();

  const aspects: unknown = item.aspects_json ? JSON.parse(item.aspects_json) : [];

  const candidate = {
    title: item.title ?? undefined,
    story: item.story ?? undefined,
    category: item.category ?? undefined,
    country: batch.country,
    postal_code: batch.postal_code,
    photo_ids: photoRows.map((row) => row.photo_id),
    aspects,
    date_of_birth: placeholderDateOfBirth(now),
  };

  const parsed = CreateListingInput.safeParse(candidate);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const detail = firstIssue?.message ?? "This item needs more details before it can be published.";
    await markItemFailed(env, entry.item_id, "invalid", detail, now);
    return "failed";
  }
  const input = parsed.data;

  // Issue #171, the bulk path's own gate — see `listings/create.ts`'s header.
  // The give flow checks this before its own insert; a draft item must be
  // held to exactly the same rule rather than a laxer one.
  if (aspectsContainContactInfo(input.aspects)) {
    await markItemFailed(env, entry.item_id, "contact_info", ASPECT_CONTACT_INFO_MESSAGE, now);
    return "failed";
  }

  const place: PostalLookup = {
    country: batch.country as Country,
    code: batch.postal_code,
    place_name: batch.place_name,
    admin1: batch.admin1,
    lat: batch.lat,
    lng: batch.lng,
  };

  const listingId = ulid(now);
  const created = await createClaimedListing(env, {
    listingId,
    ownerId: op.owner_id,
    input,
    place,
    now,
    claim: { itemId: entry.item_id, revision: entry.revision },
  });

  if (!created) {
    // The claim or the photo-eligibility guard declined. `createListingForOwner`
    // already wrote the release — `upload_batch_items.state = 'failed'`,
    // `failure_code = 'photo_conflict'` — as part of the same statement
    // batch, so there is nothing further to record here. Not retried in
    // this pass: the giver needs to see the conflict and act (usually by
    // resubmitting once the clash is resolved), not have the runner spin on
    // the same losing claim every three minutes.
    return "failed";
  }

  try {
    // Awaited, not `waitUntil` — a cron invocation has no `ExecutionContext`
    // trick that keeps work alive after this function returns the way a
    // request handler's `waitUntil` does, and `runCron` only stays alive for
    // as long as this promise does. `ITEMS_PER_INVOCATION` is what keeps this
    // bounded rather than a runaway wait.
    await moderateListing(env, listingId, 1);
  } catch (err) {
    // A moderation failure must not fail the item — the listing exists and
    // is exactly what `moderationRetry` (src/cron/moderationRetry.ts) exists
    // to pick back up.
    captureException(err, { tags: { cron: "bulkRunner" }, extra: { listingId, itemId: entry.item_id } });
  }

  // Deliberately SKIP `reembedListing`. `searchIndexRetry` already
  // re-embeds `status = 'approved' AND vector_indexed_at IS NULL` hourly, so
  // a bulk listing gets its vector after approval regardless — the cost is
  // up to an hour of FTS-only search on a listing that isn't public yet
  // anyway (still `pending`/`needs_review` until moderation clears it), and
  // the benefit is that one estate submitting 100 items in one pass cannot
  // spend the whole day's `EMBED_DAILY_BUDGET` on its own.
  return "succeeded";
}

/**
 * Works one operation for a bounded number of items, then returns. Safe to
 * call concurrently on the same operation (the lease guard below makes a
 * second concurrent caller a no-op) and safe to call again after a crash
 * (the lease expires and the cursor resumes from where it last checkpointed).
 */
export async function runBulkOperation(env: Env, operationId: string): Promise<void> {
  const now = Date.now();
  const leaseUntil = now + LEASE_MS;

  // The one guarded UPDATE that is the whole of this function's concurrency
  // story: `status IN ('queued','running')` admits both a fresh pickup and a
  // resumed one, `lease_until` losing to anything not already expired is
  // what makes two overlapping callers exclusive, and `next_attempt_at <= ?`
  // is what makes a backed-off operation wait its turn.
  const claim = await env.DB.prepare(
    `UPDATE bulk_operations
        SET status = 'running', lease_until = ?, attempts = attempts + 1, updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')
        AND (lease_until IS NULL OR lease_until < ?)
        AND next_attempt_at <= ?`,
  )
    .bind(leaseUntil, now, operationId, now, now)
    .run();

  if ((claim.meta?.changes ?? 0) === 0) {
    // Someone else holds the lease, or this operation isn't due yet, or it
    // has already finished. Nothing to do.
    return;
  }

  const op = await env.DB.prepare(`SELECT * FROM bulk_operations WHERE id = ?`).bind(operationId).first<OperationRow>();
  if (!op) return;

  const batch = await env.DB.prepare(
    `SELECT id, owner_id, country, postal_code, place_name, admin1, lat, lng FROM upload_batches WHERE id = ?`,
  )
    .bind(op.batch_id)
    .first<BatchGeoRow>();
  if (!batch) {
    // The batch is gone (cascaded from a delete elsewhere). Nothing left to
    // publish into; release the operation rather than spin on it forever.
    await env.DB.prepare(`UPDATE bulk_operations SET status = 'cancelled', updated_at = ? WHERE id = ?`)
      .bind(Date.now(), operationId)
      .run();
    return;
  }

  const selection: SelectionEntry[] = JSON.parse(op.selection_json);
  let cursor = op.cursor;
  let succeeded = op.succeeded;
  let failed = op.failed;

  try {
    const end = Math.min(selection.length, cursor + ITEMS_PER_INVOCATION);
    while (cursor < end) {
      const entry = selection[cursor];
      if (!entry) break;
      const outcome = await processItem(env, op, batch, entry, Date.now());
      if (outcome === "succeeded") succeeded += 1;
      else failed += 1;
      cursor += 1;

      // Checkpoint after every item, not just at the end of the invocation —
      // this is what makes a crash mid-batch resume from the item after the
      // last one that actually finished, instead of redoing (or skipping)
      // work.
      await env.DB.prepare(`UPDATE bulk_operations SET cursor = ?, succeeded = ?, failed = ?, updated_at = ? WHERE id = ?`)
        .bind(cursor, succeeded, failed, Date.now(), operationId)
        .run();
    }

    if (cursor >= selection.length) {
      const finishedAt = Date.now();
      await env.DB.batch([
        env.DB.prepare(`UPDATE bulk_operations SET status = 'done', finished_at = ?, updated_at = ? WHERE id = ?`).bind(
          finishedAt,
          finishedAt,
          operationId,
        ),
        env.DB.prepare(`UPDATE upload_batches SET state = 'closed', updated_at = ? WHERE id = ?`).bind(finishedAt, op.batch_id),
      ]);
    } else {
      // Release the lease and make this operation due again immediately —
      // `bulkRunner`'s next tick (at most three minutes away) picks up the
      // rest, `ITEMS_PER_INVOCATION` at a time.
      const releasedAt = Date.now();
      await env.DB.prepare(`UPDATE bulk_operations SET status = 'queued', lease_until = NULL, next_attempt_at = ?, updated_at = ? WHERE id = ?`)
        .bind(releasedAt, releasedAt, operationId)
        .run();
    }
  } catch (err) {
    // Something unexpected — not a validated-away item failure, an actual
    // exception. Release the lease, back off so the same failure doesn't
    // retry every three minutes, and surface it. The item(s) already
    // checkpointed above stay checkpointed; only the work this invocation
    // hadn't gotten to yet is retried, from `cursor`.
    const releasedAt = Date.now();
    await env.DB.prepare(`UPDATE bulk_operations SET status = 'queued', lease_until = NULL, next_attempt_at = ?, updated_at = ? WHERE id = ?`)
      .bind(releasedAt + backoffMs(op.attempts), releasedAt, operationId)
      .run();
    console.error("bulkRunner: operation failed", {
      operationId,
      error: err instanceof Error ? err.message : String(err),
    });
    captureException(err, { tags: { cron: "bulkRunner" }, extra: { operationId } });
  }
}

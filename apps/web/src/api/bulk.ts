/**
 * Typed client for `/api/bulk/*` — estate bulk upload. Follows
 * `src/api/listings.ts`'s pattern: validate the request with the shared zod
 * contract before the round trip, validate the response the same way after
 * it, so a drift between this client and `@keepsake/contracts/bulk` fails
 * loudly and locally instead of shipping a malformed value into a screen.
 *
 * Every call here is owner-authenticated (`owner: true` — see
 * `src/api/client.ts`). Every *write* also carries the caller's admission
 * grant id in `BULK_GRANT_HEADER` (`x-bulk-grant`) — the grant proves *how
 * much* work has been admitted, `Authorization` proves *whose* batch it is;
 * `apps/api/src/middleware/bulkGrant.ts`'s header comment explains why the
 * grant id itself travels unencrypted. Reads never need it: `GET` routes on
 * `bulkRoutes` mount no `requireGrant()`.
 *
 * ## Typed outcomes instead of generic throws
 *
 * A screen driving 100 items and 300 photos needs to tell three situations
 * apart, and a caught `ApiError` alone can't: was this edited elsewhere
 * (409, reload and retry), has this account run out of admission (403/429
 * with no `retryAfter` — needs a fresh grant from the operator, no amount of
 * waiting fixes it), or is this a resumable pause (429 *with* `retryAfter` —
 * the per-minute burst ceiling, wait and go again)? Every mutating call
 * below returns a `BulkResult<T>` rather than throwing for any of those
 * three cases, via `classifyBulkError`. A response the API was never meant
 * to send — a validation bug, a 500, a client-side zod mismatch — still
 * throws, the same as every other `src/api/*` module: that is a bug to
 * surface loudly, not a state for the give-flow-style UI to render around.
 */
import { z } from "zod";
import { PhotoSuggestionSchema, type PhotoSuggestion } from "@keepsake/contracts/photo";
import { UlidSchema } from "@keepsake/contracts/common";
import {
  BULK_GRANT_HEADER,
  BatchDetail,
  BatchItemSummary,
  BatchPhotoSummary,
  BatchStateSchema,
  BatchSummary,
  BulkGrantSummary,
  BulkOperationSummary,
  CreateBatchInput as CreateBatchInputSchema,
  SubmitBatchInput as SubmitBatchInputSchema,
  UpdateBatchInput as UpdateBatchInputSchema,
  UpsertBatchItemInput as UpsertBatchItemInputSchema,
  type CreateBatchInput,
  type SubmitBatchInput,
  type UpdateBatchInput,
  type UpsertBatchItemInput,
} from "@keepsake/contracts/bulk";
import { ApiError, apiFetch } from "@/api/client";
import { fixPhotoUrls } from "@/api/fixPhotoUrls";

// ---------------------------------------------------------------------------
// Typed write outcomes
// ---------------------------------------------------------------------------

/**
 * Why a bulk write didn't produce a value. `retryAfterSeconds` is present
 * only on `"throttled"` — the one kind a screen should treat as a pause
 * rather than a failure, per this module's header.
 */
export type BulkWriteError =
  /** 409 — `expected_revision` (or the item's own revision-on-update path)
   * didn't match. Reload the batch/item and let the giver reconcile. */
  | { kind: "conflict"; message: string }
  /** 403 from `requireGrant()` — no `x-bulk-grant` header reached the
   * server, or the grant it named isn't usable (expired, revoked, someone
   * else's). Not the same as running out of admission *within* a valid
   * grant — see `"admission_exhausted"`. */
  | { kind: "no_grant"; message: string }
  /** 429 with no `Retry-After` — the grant (or the account's daily
   * ceiling with no grant-side room behind it) has nothing left. Waiting
   * doesn't help; the giver needs a fresh grant from the operator. */
  | { kind: "admission_exhausted"; message: string }
  /** 429 *with* `Retry-After` — a burst ceiling, not exhaustion. The caller
   * (`uploadQueue.ts`) treats this as a pause: stop issuing new writes until
   * `retryAfterSeconds` has passed, then resume the same request. */
  | { kind: "throttled"; message: string; retryAfterSeconds: number }
  /** `fetch` itself failed — offline, DNS, CORS. Nothing reached the
   * server, so this is unambiguously retryable once connectivity returns. */
  | { kind: "network"; message: string }
  /** Every other `ApiError` — a 404, a 400 from a validation the client
   * missed, a 5xx. Carries the raw code/status so a caller that wants to
   * branch further still can, without this module inventing a kind for
   * every one of `ErrorCode`'s members. */
  | { kind: "unexpected"; message: string; code: ApiError["code"]; status: number };

export type BulkResult<T> = { ok: true; data: T } | { ok: false; error: BulkWriteError };

/** Exported so `uploadQueue.ts` (and tests) can classify an `ApiError` the
 * same way without re-deriving this table. Rethrows anything that isn't an
 * `ApiError` — a zod `.parse()` failure on a request we built ourselves, for
 * instance, is this module's own bug and must not be swallowed into a
 * `BulkResult`. */
export function classifyBulkError(error: unknown): BulkWriteError {
  if (!(error instanceof ApiError)) throw error;
  if (error.code === "conflict") return { kind: "conflict", message: error.message };
  if (error.code === "forbidden") return { kind: "no_grant", message: error.message };
  if (error.code === "rate_limited") {
    if (error.retryAfter !== undefined) {
      return { kind: "throttled", message: error.message, retryAfterSeconds: error.retryAfter };
    }
    return { kind: "admission_exhausted", message: error.message };
  }
  if (error.code === "unavailable") return { kind: "network", message: error.message };
  return { kind: "unexpected", message: error.message, code: error.code, status: error.status };
}

async function asBulkResult<T>(run: () => Promise<T>): Promise<BulkResult<T>> {
  try {
    return { ok: true, data: await run() };
  } catch (error) {
    return { ok: false, error: classifyBulkError(error) };
  }
}

export type BulkWriteOptions = {
  /** The admission grant this write should be charged against — sent as
   * `x-bulk-grant`. Required on every function in this module for
   * uniformity (`bulkRoutes`' own `DELETE`s don't currently spend a grant,
   * but sending the header costs nothing and keeps one calling convention
   * for every write here rather than a per-route exception a screen has to
   * remember). */
  grantId: string;
  signal?: AbortSignal;
};

function grantHeaders(grantId: string): Record<string, string> {
  return { [BULK_GRANT_HEADER]: grantId };
}

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

export async function createBatch(input: CreateBatchInput, options: BulkWriteOptions): Promise<BulkResult<BatchSummary>> {
  const body = CreateBatchInputSchema.parse(input);
  return asBulkResult(async () => {
    const data = await apiFetch<unknown>("/api/bulk/batches", {
      method: "POST",
      body,
      owner: true,
      headers: grantHeaders(options.grantId),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    return BatchSummary.parse(data);
  });
}

/** `GET /api/bulk/batches` — every batch this owner has, newest activity
 * first per the API's own ordering; this client doesn't re-sort. */
export async function listBatches(signal?: AbortSignal): Promise<BatchSummary[]> {
  const data = await apiFetch<unknown>("/api/bulk/batches", {
    owner: true,
    ...(signal !== undefined ? { signal } : {}),
  });
  return z.object({ items: z.array(BatchSummary) }).parse(data).items;
}

/** `GET /api/bulk/batches/:id` — items and photos included, straight from
 * `fixPhotoUrls` before `BatchDetail.parse` so `photos[].url_thumb`
 * validates the same way every other photo URL in this app does. */
export async function getBatch(id: string, signal?: AbortSignal): Promise<BatchDetail> {
  const data = await apiFetch<unknown>(`/api/bulk/batches/${encodeURIComponent(id)}`, {
    owner: true,
    ...(signal !== undefined ? { signal } : {}),
  });
  return BatchDetail.parse(fixPhotoUrls(data));
}

export async function updateBatch(id: string, input: UpdateBatchInput, options: BulkWriteOptions): Promise<BulkResult<BatchSummary>> {
  const body = UpdateBatchInputSchema.parse(input);
  return asBulkResult(async () => {
    const data = await apiFetch<unknown>(`/api/bulk/batches/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body,
      owner: true,
      headers: grantHeaders(options.grantId),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    return BatchSummary.parse(data);
  });
}

const CancelBatchResult = z.object({
  id: UlidSchema,
  state: BatchStateSchema,
  /** The listings this batch had already created before it was cancelled —
   * cancelling never unwinds a published listing, only the batch's
   * remaining, unsubmitted work. */
  listing_ids: z.array(UlidSchema),
});
export type CancelBatchResult = z.infer<typeof CancelBatchResult>;

/** `DELETE /api/bulk/batches/:id` — cancel. No grant is spent by a cancel
 * (`bulkRoutes`' `DELETE /batches/:id` mounts no `requireGrant()`), but see
 * `BulkWriteOptions`'s comment for why the header is still sent. */
export async function cancelBatch(id: string, options: BulkWriteOptions): Promise<BulkResult<CancelBatchResult>> {
  return asBulkResult(async () => {
    const data = await apiFetch<unknown>(`/api/bulk/batches/${encodeURIComponent(id)}`, {
      method: "DELETE",
      owner: true,
      headers: grantHeaders(options.grantId),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    return CancelBatchResult.parse(data);
  });
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export async function upsertBatchItem(
  batchId: string,
  clientItemId: string,
  input: UpsertBatchItemInput,
  options: BulkWriteOptions,
): Promise<BulkResult<BatchItemSummary>> {
  const body = UpsertBatchItemInputSchema.parse(input);
  return asBulkResult(async () => {
    const data = await apiFetch<unknown>(
      `/api/bulk/batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(clientItemId)}`,
      {
        method: "PUT",
        body,
        owner: true,
        headers: grantHeaders(options.grantId),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
    );
    return BatchItemSummary.parse(data);
  });
}

const DeleteItemResult = z.object({ id: UlidSchema });

export async function deleteBatchItem(
  batchId: string,
  clientItemId: string,
  options: BulkWriteOptions,
): Promise<BulkResult<{ id: string }>> {
  return asBulkResult(async () => {
    const data = await apiFetch<unknown>(
      `/api/bulk/batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(clientItemId)}`,
      {
        method: "DELETE",
        owner: true,
        headers: grantHeaders(options.grantId),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
    );
    return DeleteItemResult.parse(data);
  });
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

export type UploadBatchPhotoInput = {
  full: Blob;
  thumb: Blob;
  width: number;
  height: number;
  blurhash: string;
};

/** `PUT /api/bulk/batches/:id/photos/:clientPhotoId` — same field names as
 * `src/api/photos.ts`'s `uploadPhoto`, multipart. Resolves to the *existing*
 * photo on a retried call with the same `clientPhotoId` (the server's own
 * D1 unique index, not this client) — see this module's header and
 * `uploadQueue.ts`, which is the only caller that needs that guarantee. */
export async function uploadBatchPhoto(
  batchId: string,
  clientPhotoId: string,
  input: UploadBatchPhotoInput,
  options: BulkWriteOptions,
): Promise<BulkResult<BatchPhotoSummary>> {
  const form = new FormData();
  form.append("full", input.full, "full.jpg");
  form.append("thumb", input.thumb, "thumb.jpg");
  form.append("width", String(input.width));
  form.append("height", String(input.height));
  form.append("blurhash", input.blurhash);

  return asBulkResult(async () => {
    const data = await apiFetch<unknown>(
      `/api/bulk/batches/${encodeURIComponent(batchId)}/photos/${encodeURIComponent(clientPhotoId)}`,
      {
        method: "PUT",
        body: form,
        owner: true,
        headers: grantHeaders(options.grantId),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
    );
    return BatchPhotoSummary.parse(fixPhotoUrls(data));
  });
}

const DeletePhotoResult = z.object({ id: UlidSchema });

export async function deleteBatchPhoto(
  batchId: string,
  clientPhotoId: string,
  options: BulkWriteOptions,
): Promise<BulkResult<{ id: string }>> {
  return asBulkResult(async () => {
    const data = await apiFetch<unknown>(
      `/api/bulk/batches/${encodeURIComponent(batchId)}/photos/${encodeURIComponent(clientPhotoId)}`,
      {
        method: "DELETE",
        owner: true,
        headers: grantHeaders(options.grantId),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
    );
    return DeletePhotoResult.parse(data);
  });
}

const SuggestBatchPhotoResult = z.object({ suggestion: PhotoSuggestionSchema.nullable() });

/**
 * `POST /api/bulk/batches/:id/photos/:clientPhotoId/suggest` — spends the
 * grant's own `suggestions_remaining` (`BulkGrantSummary`, separate from
 * `items_remaining`/`photos_remaining`), so running out of suggestions is a
 * `BulkResult` outcome here, not a thrown `ApiError` the way `src/api/
 * photos.ts`'s `suggestPhoto` treats every request failure — this is a
 * *write* on `bulkRoutes` (metered, and gated the same as the item/photo
 * admission paths) even though it reads like a query. `ok:true, data:null`
 * still covers the model itself declining (timed out, hit the daily model
 * budget) — that was never an admission problem and isn't one now.
 *
 * Screens are expected to treat `"admission_exhausted"`/`"throttled"` here
 * as "no suggestion this time", never as a reason to block the item or the
 * batch: a giver can title, categorize, and submit every item by hand with
 * zero suggestions spent, same as the ordinary give flow always could.
 */
export async function suggestBatchPhoto(
  batchId: string,
  clientPhotoId: string,
  options: BulkWriteOptions,
): Promise<BulkResult<PhotoSuggestion | null>> {
  return asBulkResult(async () => {
    const data = await apiFetch<unknown>(
      `/api/bulk/batches/${encodeURIComponent(batchId)}/photos/${encodeURIComponent(clientPhotoId)}/suggest`,
      {
        method: "POST",
        owner: true,
        headers: grantHeaders(options.grantId),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
    );
    return SuggestBatchPhotoResult.parse(data).suggestion;
  });
}

// ---------------------------------------------------------------------------
// Submission and operations
// ---------------------------------------------------------------------------

/** `POST /api/bulk/batches/:id/submit` — 202, a `BulkOperationSummary` to
 * poll (`getOperation`/`listBatchOperations` below). */
export async function submitBatch(
  batchId: string,
  input: SubmitBatchInput,
  options: BulkWriteOptions,
): Promise<BulkResult<BulkOperationSummary>> {
  const body = SubmitBatchInputSchema.parse(input);
  return asBulkResult(async () => {
    const data = await apiFetch<unknown>(`/api/bulk/batches/${encodeURIComponent(batchId)}/submit`, {
      method: "POST",
      body,
      owner: true,
      headers: grantHeaders(options.grantId),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    return BulkOperationSummary.parse(data);
  });
}

export async function getOperation(id: string, signal?: AbortSignal): Promise<BulkOperationSummary> {
  const data = await apiFetch<unknown>(`/api/bulk/operations/${encodeURIComponent(id)}`, {
    owner: true,
    ...(signal !== undefined ? { signal } : {}),
  });
  return BulkOperationSummary.parse(data);
}

export async function listBatchOperations(batchId: string, signal?: AbortSignal): Promise<BulkOperationSummary[]> {
  const data = await apiFetch<unknown>(`/api/bulk/batches/${encodeURIComponent(batchId)}/operations`, {
    owner: true,
    ...(signal !== undefined ? { signal } : {}),
  });
  return z.object({ items: z.array(BulkOperationSummary) }).parse(data).items;
}

export async function retryOperation(id: string, options: BulkWriteOptions): Promise<BulkResult<BulkOperationSummary>> {
  return asBulkResult(async () => {
    const data = await apiFetch<unknown>(`/api/bulk/operations/${encodeURIComponent(id)}/retry`, {
      method: "POST",
      owner: true,
      headers: grantHeaders(options.grantId),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    return BulkOperationSummary.parse(data);
  });
}

const DeleteOperationResult = z.object({ id: UlidSchema });

export async function deleteOperation(id: string, options: BulkWriteOptions): Promise<BulkResult<{ id: string }>> {
  return asBulkResult(async () => {
    const data = await apiFetch<unknown>(`/api/bulk/operations/${encodeURIComponent(id)}`, {
      method: "DELETE",
      owner: true,
      headers: grantHeaders(options.grantId),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    return DeleteOperationResult.parse(data);
  });
}

// ---------------------------------------------------------------------------
// Admission grant
// ---------------------------------------------------------------------------

/** Re-exported so a caller holding a `BulkGrantSummary` (handed to a giver
 * by the operator who minted it — no route here fetches one; the pilot's
 * `POST /api/admin/bulk/grants` is admin-only) can type it without a second
 * import from `@keepsake/contracts/bulk`. */
export type { BulkGrantSummary };

/**
 * Three independent ceilings, not one — `items_remaining`,
 * `photos_remaining`, and `suggestions_remaining` are spent by different
 * writes and can each hit zero on their own schedule. A screen must not
 * read `hasAdmission(grant, "suggestions") === false` as "this batch is
 * stuck": every other kind of work continues normally, and a giver can
 * title, categorize, and submit an entire batch by hand with zero
 * suggestions ever spent, the same as the ordinary give flow always could.
 */
export function hasAdmission(grant: BulkGrantSummary, kind: "items" | "photos" | "suggestions"): boolean {
  if (kind === "items") return grant.items_remaining > 0;
  if (kind === "photos") return grant.photos_remaining > 0;
  return grant.suggestions_remaining > 0;
}

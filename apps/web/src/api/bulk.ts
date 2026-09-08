/**
 * Typed client for `/api/bulk/*` — estate bulk upload. Follows
 * `src/api/listings.ts`'s pattern: validate the request with the shared zod
 * contract before the round trip, validate the response the same way after
 * it, so a drift between this client and `@keepsake/contracts/bulk` fails
 * loudly and locally instead of shipping a malformed value into a screen.
 *
 * Every call here is owner-authenticated (`owner: true` — see
 * `src/api/client.ts`), and that is the whole of a bulk caller's identity.
 * There is no admission code: the `x-bulk-grant` header, and the operator
 * step behind it, were removed — see `apps/api/src/bulk/usage.ts` for what
 * bounds a batch now.
 *
 * ## Typed outcomes instead of generic throws
 *
 * A screen driving 100 items and 300 photos needs to tell three situations
 * apart, and a caught `ApiError` alone can't: was this edited elsewhere
 * (409, reload and retry), has this account hit a ceiling that only lifts at
 * UTC midnight — or filled a batch, which no wait empties — or is this a
 * resumable pause, the per-minute burst ceiling? The last two are both 429s
 * carrying `Retry-After`, so it is the *size* of that wait that separates
 * them; see `MAX_PAUSE_SECONDS`. Every mutating call
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
  BatchDetail,
  BatchItemSummary,
  BatchPhotoSummary,
  BatchStateSchema,
  BatchSummary,
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
  /** 429 that no realistic wait fixes: this account's daily ceiling for the
   * kind of write attempted (its `Retry-After` counts down to UTC midnight,
   * which can be most of a day), or a batch that already holds all it can
   * (no `Retry-After` at all — waiting never empties a batch). The API's own
   * message says which, and what to do about it. */
  | { kind: "limit_reached"; message: string }
  /** 429 with a *short* `Retry-After` — the per-minute burst ceiling, not
   * exhaustion. The caller (`uploadQueue.ts`) treats this as a pause: stop
   * issuing new writes until `retryAfterSeconds` has passed, then resume the
   * same request. See `MAX_PAUSE_SECONDS` for where the line is drawn. */
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

/**
 * The longest `Retry-After` this module will call a *pause*.
 *
 * A 429 carrying `Retry-After` used to mean exactly one thing here — the
 * router-level burst brake, whose window is a minute — so any `Retry-After`
 * was safe to sleep through. It no longer does: a per-owner daily ceiling
 * (`bulk_owner_usage`, `apps/api/src/bulk/usage.ts`) answers 429 with
 * `secondsUntilMidnightUTC()`, up to 86,400. Classifying that as
 * `"throttled"` hands it to `uploadQueue.pauseFor`, which would park the
 * whole queue — no failed tile, no message, just a "paused" workspace — for
 * the rest of the UTC day.
 *
 * Five minutes is comfortably above the burst window and far below any
 * daily ceiling, so the two never collide. The number is a *client-side
 * policy about what a giver will sit through*, not a mirror of any server
 * constant: the API stays honest and keeps saying exactly when the ceiling
 * lifts; this only decides whether waiting is something to do silently or
 * something to tell them about.
 */
export const MAX_PAUSE_SECONDS = 300;

/** Exported so `uploadQueue.ts` (and tests) can classify an `ApiError` the
 * same way without re-deriving this table. Rethrows anything that isn't an
 * `ApiError` — a zod `.parse()` failure on a request we built ourselves, for
 * instance, is this module's own bug and must not be swallowed into a
 * `BulkResult`. */
export function classifyBulkError(error: unknown): BulkWriteError {
  if (!(error instanceof ApiError)) throw error;
  if (error.code === "conflict") return { kind: "conflict", message: error.message };
  if (error.code === "rate_limited") {
    if (error.retryAfter !== undefined && error.retryAfter <= MAX_PAUSE_SECONDS) {
      return { kind: "throttled", message: error.message, retryAfterSeconds: error.retryAfter };
    }
    return { kind: "limit_reached", message: error.message };
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
  signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

export async function createBatch(input: CreateBatchInput, options: BulkWriteOptions = {}): Promise<BulkResult<BatchSummary>> {
  const body = CreateBatchInputSchema.parse(input);
  return asBulkResult(async () => {
    const data = await apiFetch<unknown>("/api/bulk/batches", {
      method: "POST",
      body,
      owner: true,
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

export async function updateBatch(id: string, input: UpdateBatchInput, options: BulkWriteOptions = {}): Promise<BulkResult<BatchSummary>> {
  const body = UpdateBatchInputSchema.parse(input);
  return asBulkResult(async () => {
    const data = await apiFetch<unknown>(`/api/bulk/batches/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body,
      owner: true,
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

/** `DELETE /api/bulk/batches/:id` — cancel. Never unwinds a listing this
 * batch already published; see `CancelBatchResult.listing_ids`. */
export async function cancelBatch(id: string, options: BulkWriteOptions = {}): Promise<BulkResult<CancelBatchResult>> {
  return asBulkResult(async () => {
    const data = await apiFetch<unknown>(`/api/bulk/batches/${encodeURIComponent(id)}`, {
      method: "DELETE",
      owner: true,
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
  options: BulkWriteOptions = {},
): Promise<BulkResult<BatchItemSummary>> {
  const body = UpsertBatchItemInputSchema.parse(input);
  return asBulkResult(async () => {
    const data = await apiFetch<unknown>(
      `/api/bulk/batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(clientItemId)}`,
      {
        method: "PUT",
        body,
        owner: true,
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
  options: BulkWriteOptions = {},
): Promise<BulkResult<{ id: string }>> {
  return asBulkResult(async () => {
    const data = await apiFetch<unknown>(
      `/api/bulk/batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(clientItemId)}`,
      {
        method: "DELETE",
        owner: true,
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
  options: BulkWriteOptions = {},
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
  options: BulkWriteOptions = {},
): Promise<BulkResult<{ id: string }>> {
  return asBulkResult(async () => {
    const data = await apiFetch<unknown>(
      `/api/bulk/batches/${encodeURIComponent(batchId)}/photos/${encodeURIComponent(clientPhotoId)}`,
      {
        method: "DELETE",
        owner: true,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
    );
    return DeletePhotoResult.parse(data);
  });
}

const SuggestBatchPhotoResult = z.object({ suggestion: PhotoSuggestionSchema.nullable() });

/**
 * `POST /api/bulk/batches/:id/photos/:clientPhotoId/suggest` — spends this
 * owner's daily suggestion allowance (`bulk_owner_usage.suggestions_used`,
 * counted separately from items and photos), so running out of suggestions
 * is a `BulkResult` outcome here, not a thrown `ApiError` the way `src/api/
 * photos.ts`'s `suggestPhoto` treats every request failure — this is a
 * *write* on `bulkRoutes` (metered, and charged the same way the item and
 * photo paths are) even though it reads like a query. `ok:true, data:null`
 * still covers the model itself declining (timed out, hit the daily model
 * budget) — that was never a ceiling problem and isn't one now.
 *
 * Screens are expected to treat `"limit_reached"`/`"throttled"` here as "no
 * suggestion this time", never as a reason to block the item or the batch:
 * a giver can title, categorize, and submit every item by hand with zero
 * suggestions spent, same as the ordinary give flow always could.
 */
export async function suggestBatchPhoto(
  batchId: string,
  clientPhotoId: string,
  options: BulkWriteOptions = {},
): Promise<BulkResult<PhotoSuggestion | null>> {
  return asBulkResult(async () => {
    const data = await apiFetch<unknown>(
      `/api/bulk/batches/${encodeURIComponent(batchId)}/photos/${encodeURIComponent(clientPhotoId)}/suggest`,
      {
        method: "POST",
        owner: true,
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
  options: BulkWriteOptions = {},
): Promise<BulkResult<BulkOperationSummary>> {
  const body = SubmitBatchInputSchema.parse(input);
  return asBulkResult(async () => {
    const data = await apiFetch<unknown>(`/api/bulk/batches/${encodeURIComponent(batchId)}/submit`, {
      method: "POST",
      body,
      owner: true,
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

export async function retryOperation(id: string, options: BulkWriteOptions = {}): Promise<BulkResult<BulkOperationSummary>> {
  return asBulkResult(async () => {
    const data = await apiFetch<unknown>(`/api/bulk/operations/${encodeURIComponent(id)}/retry`, {
      method: "POST",
      owner: true,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    return BulkOperationSummary.parse(data);
  });
}

const DeleteOperationResult = z.object({ id: UlidSchema });

export async function deleteOperation(id: string, options: BulkWriteOptions = {}): Promise<BulkResult<{ id: string }>> {
  return asBulkResult(async () => {
    const data = await apiFetch<unknown>(`/api/bulk/operations/${encodeURIComponent(id)}`, {
      method: "DELETE",
      owner: true,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    return DeleteOperationResult.parse(data);
  });
}

/**
 * The bounded photo-upload pipeline for one bulk batch.
 *
 * Two stages, deliberately paced differently:
 *
 * 1. **Decode**, one at a time, across the whole queue — not per item, not
 *    two at once. `prepareUpload` (`lib/images/prepareUpload.ts`) is reused
 *    completely unchanged: its single `createImageBitmap` call is *why*
 *    phones stopped OOMing on the give flow (see that file's own header),
 *    and running two of those concurrently here would reopen exactly the
 *    bug it fixed, just with 300 photos instead of 5 to trigger it. Nothing
 *    in this file re-parallelises it — `DecodeGate` below exists to make
 *    that structural, not a convention someone can accidentally break.
 * 2. **Upload**, up to `maxConcurrentUploads` at once (default 2) and paced
 *    to at most `maxUploadsPerMinute` starts in any trailing 60s window.
 *    Both are runtime-configurable via `updateLimits` rather than baked in:
 *    the plan names an `RL_BULK_UPLOAD` binding "sized for roughly two
 *    uploads in flight" that a sibling agent is adding on the API side —
 *    this file cannot see its final numbers, so it takes them as config
 *    instead of guessing.
 *
 * A 429 with `Retry-After` (`classifyBulkError`'s `"throttled"`) pauses the
 * whole queue for that long rather than failing the photo that hit it — see
 * `handleFailure` below. Everything else that can fail a photo is
 * classified by `classifyPhotoUploadFailure`, reusing the exact taxonomy
 * `app/give/index.tsx`'s `classifyUploadFailure` already established
 * (timeouts and network/5xx are retryable, a refused shape or format is
 * not), so a giver who has used the ordinary give flow sees the same rules
 * here.
 *
 * ## Resumability
 *
 * `resume()` seeds the queue from whatever `storage.ts` still has queued or
 * mid-upload after a reload. A photo that was `"uploading"` when the tab
 * closed goes back to `"queued"` and is retried from scratch — safe because
 * `PUT /api/bulk/batches/:id/photos/:clientPhotoId` resolves a retried
 * `clientPhotoId` to the row that already exists rather than creating a
 * second one (`src/api/bulk.ts`'s `uploadBatchPhoto`, and the route's own
 * comment on why that's a D1 unique index and not a client-side guard). A
 * photo whose source `Blob` didn't survive — evicted by the browser, or
 * simply never persisted before a crash — comes back with `needsReselection`
 * instead: this module never invents bytes it doesn't have, and never
 * blocks the rest of the batch on the one photo that needs a human to pick
 * the file again.
 *
 * This module does not run when the tab is closed and does not claim to: no
 * background sync, no service worker. "Resumable after a reload" means
 * exactly that — the reload that's still driven by an open tab.
 */
import type { BatchPhotoSummary } from "@keepsake/contracts/bulk";
import { ImagePrepError } from "@/lib/images/resizeImage";
import { prepareUpload as defaultPrepareUpload, type PreparedUpload } from "@/lib/images/prepareUpload";
import type { BulkResult, BulkWriteError } from "@/api/bulk";
import type { BulkDraftPhoto } from "@/features/bulk/batchStore";
import {
  dropPhotoSource,
  getPhotoSource,
  savePhotoSource,
  type BulkStorageDriver,
} from "@/features/bulk/storage";

// ---------------------------------------------------------------------------
// Failure classification — mirrors app/give/index.tsx's classifyUploadFailure
// ---------------------------------------------------------------------------

export type PhotoUploadFailure = { message: string; errorCode: string; canRetry: boolean };

/** Exported for `uploadQueue.test.ts` and any screen that wants to render a
 * failure the same way without re-deriving these rules. `throttled` is
 * handled by the caller before this ever runs (see `handleFailure`) — this
 * function only classifies genuine per-photo failures. */
export function classifyPhotoUploadFailure(error: unknown): PhotoUploadFailure {
  if (error instanceof ImagePrepError) {
    return { message: error.message, errorCode: error.code, canRetry: error.code === "timed_out" };
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return { message: "Cancelled.", errorCode: "aborted", canRetry: false };
  }
  return { message: "That upload didn't go through. Try again.", errorCode: "unknown", canRetry: true };
}

function classifyBulkWriteFailure(error: BulkWriteError): PhotoUploadFailure {
  switch (error.kind) {
    case "network":
      return { message: error.message, errorCode: "network", canRetry: true };
    case "no_grant":
      return { message: error.message, errorCode: "no_grant", canRetry: false };
    case "admission_exhausted":
      return { message: error.message, errorCode: "admission_exhausted", canRetry: false };
    case "conflict":
      // Not reachable through the photo route today (no revision on a
      // photo upsert), but classified rather than left to fall through to
      // "unexpected" in case that ever changes.
      return { message: error.message, errorCode: "conflict", canRetry: false };
    case "unexpected":
      return { message: error.message, errorCode: error.code, canRetry: error.status === 0 || error.status >= 500 };
    case "throttled":
      // Handled by the caller before classification (see `handleFailure`,
      // which special-cases `"throttled"` as a pause rather than a
      // failure) — this arm only exists so the switch is exhaustive over
      // `BulkWriteError["kind"]`. If it's ever reached directly, treat it
      // as retryable rather than dead-ending the giver.
      return { message: error.message, errorCode: "throttled", canRetry: true };
  }
}

// ---------------------------------------------------------------------------
// DecodeGate — serializes prepareUpload across the whole queue
// ---------------------------------------------------------------------------

class DecodeGate {
  private chain: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const turn = this.chain.then(fn, fn);
    // Swallow here so one decode's rejection doesn't poison the chain for
    // the next photo waiting behind it; the real rejection still reaches
    // this call's own caller via `turn`.
    this.chain = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }
}

// ---------------------------------------------------------------------------
// RateLimiter — concurrency + a sliding per-minute window, both live-tunable
// ---------------------------------------------------------------------------

export type RateLimiterConfig = { maxConcurrent: number; maxPerMinute: number };

const WINDOW_MS = 60_000;

/** A slot gate for the upload stage: at most `maxConcurrent` acquisitions
 * outstanding, and at most `maxPerMinute` *starts* in any trailing 60s
 * window. Time source is injectable so tests don't need real 60-second
 * waits. */
export class RateLimiter {
  private config: RateLimiterConfig;
  private readonly now: () => number;
  private inFlight = 0;
  private starts: number[] = [];
  private waiters: (() => void)[] = [];

  constructor(config: RateLimiterConfig, now: () => number = Date.now) {
    this.config = config;
    this.now = now;
  }

  updateConfig(patch: Partial<RateLimiterConfig>): void {
    this.config = { ...this.config, ...patch };
    this.pump();
  }

  private trimWindow(): void {
    const cutoff = this.now() - WINDOW_MS;
    while (this.starts.length > 0 && this.starts[0]! <= cutoff) this.starts.shift();
  }

  private canStartNow(): boolean {
    this.trimWindow();
    return this.inFlight < this.config.maxConcurrent && this.starts.length < this.config.maxPerMinute;
  }

  /** Milliseconds until the oldest tracked start ages out of the window —
   * `0` when a slot is already free right now. */
  msUntilNextSlot(): number {
    if (this.canStartNow()) return 0;
    if (this.inFlight >= this.config.maxConcurrent) return -1; // waiting on a release, not the clock
    const oldest = this.starts[0];
    return oldest === undefined ? 0 : Math.max(0, oldest + WINDOW_MS - this.now());
  }

  private pump(): void {
    while (this.waiters.length > 0 && this.canStartNow()) {
      this.inFlight += 1;
      this.starts.push(this.now());
      const resolve = this.waiters.shift()!;
      resolve();
    }
  }

  /** Resolves once a slot is available, having reserved it (call `release()`
   * when the operation finishes). Rejects if `signal` aborts first. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const release = (): void => {
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.pump();
      };
      const grant = (): void => resolve(release);

      if (this.canStartNow()) {
        this.inFlight += 1;
        this.starts.push(this.now());
        grant();
        return;
      }

      const waiter = (): void => grant();
      this.waiters.push(waiter);

      if (signal !== undefined) {
        const onAbort = (): void => {
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(new DOMException("Aborted", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  /** Forces every waiter to stand down until `resumeAt` — used for a
   * `"throttled"` pause. Not a queue of its own; it just stops `pump` from
   * granting anything until the clock passes `resumeAt`, by holding
   * `maxConcurrent` at 0 and restoring it after. */
  async pauseUntil(resumeAt: number, sleep: (ms: number) => Promise<void>): Promise<void> {
    const saved = this.config.maxConcurrent;
    this.config = { ...this.config, maxConcurrent: 0 };
    const wait = Math.max(0, resumeAt - this.now());
    await sleep(wait);
    this.config = { ...this.config, maxConcurrent: saved };
    this.pump();
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// UploadQueue
// ---------------------------------------------------------------------------

export type QueuedSource = { clientPhotoId: string; source: Blob };

export type UploadPhotoFn = (args: {
  clientPhotoId: string;
  full: Blob;
  thumb: Blob;
  width: number;
  height: number;
  blurhash: string;
  signal: AbortSignal;
}) => Promise<BulkResult<BatchPhotoSummary>>;

export type UploadQueueOptions = {
  batchKey: string;
  driver: BulkStorageDriver;
  uploadPhoto: UploadPhotoFn;
  /** Reused verbatim by default — see this file's header. Overridable only
   * for tests. */
  prepareUpload?: (source: Blob, options: { signal?: AbortSignal }) => Promise<PreparedUpload>;
  maxConcurrentUploads?: number;
  maxUploadsPerMinute?: number;
  /** Called with a patch every time a photo's status changes — the caller
   * (a thin React wrapper, ultimately) is expected to both dispatch this
   * into `batchStore.ts`'s reducer and let it happen; this module owns no
   * canonical state of its own. */
  onPhotoUpdate: (clientPhotoId: string, patch: Partial<BulkDraftPhoto>) => void;
  /** Fired once a photo's server row is confirmed — the caller's cue to run
   * `photo_synced` against the reducer, which is the only place the
   * server's `url_thumb`/`photo_id`/`position` land. */
  onPhotoSynced?: (summary: BatchPhotoSummary) => void;
  /** Fired when the whole queue pauses on a `"throttled"` response, and
   * again when it resumes — purely informational, for a screen that wants
   * to say "pausing for a bit" rather than looking stuck. */
  onPause?: (resumeAt: number) => void;
  onResume?: () => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

type TrackedPhoto = { source: Blob; controller: AbortController };

export class UploadQueue {
  private readonly batchKey: string;
  private readonly driver: BulkStorageDriver;
  private readonly uploadPhoto: UploadPhotoFn;
  private readonly prepareUpload: (source: Blob, options: { signal?: AbortSignal }) => Promise<PreparedUpload>;
  private readonly onPhotoUpdate: UploadQueueOptions["onPhotoUpdate"];
  private readonly onPhotoSynced: UploadQueueOptions["onPhotoSynced"];
  private readonly onPause: UploadQueueOptions["onPause"];
  private readonly onResume: UploadQueueOptions["onResume"];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly decodeGate = new DecodeGate();
  private readonly limiter: RateLimiter;

  private pending: string[] = [];
  private tracked = new Map<string, TrackedPhoto>();
  private paused: Promise<void> | null = null;
  private destroyed = false;
  private grantId = "";

  constructor(options: UploadQueueOptions) {
    this.batchKey = options.batchKey;
    this.driver = options.driver;
    this.uploadPhoto = options.uploadPhoto;
    // `prepareUpload`'s real signature takes a `File` (it reads `.name` for
    // the HEIC-by-extension check in `looksLikeHeic`) — every intake path
    // (`<input type="file">`, a drop) hands one in, and a resumed source
    // read back out of IndexedDB (`storage.ts`'s `getPhotoSource`) is
    // typed `Blob` here only because that's what the browser's own
    // `IDBObjectStore` API returns; a `File` stored via `savePhotoSource`
    // does round-trip as one at runtime (structured clone preserves it),
    // so this cast reflects that, not a real type gap.
    this.prepareUpload = options.prepareUpload ?? ((source, opts) => defaultPrepareUpload(source as File, opts));
    this.onPhotoUpdate = options.onPhotoUpdate;
    this.onPhotoSynced = options.onPhotoSynced;
    this.onPause = options.onPause;
    this.onResume = options.onResume;
    this.sleep = options.sleep ?? defaultSleep;
    this.limiter = new RateLimiter(
      { maxConcurrent: options.maxConcurrentUploads ?? 2, maxPerMinute: options.maxUploadsPerMinute ?? 20 },
      options.now ?? Date.now,
    );
  }

  /** Live-tune concurrency/pacing — e.g. once the real `RL_BULK_UPLOAD`
   * ceiling is known, or a screen wants to back off after seeing pauses. */
  updateLimits(patch: Partial<RateLimiterConfig>): void {
    this.limiter.updateConfig(patch);
  }

  /** Updates the grant id sent with each upload — needed after
   * `"admission_exhausted"`/`"no_grant"` once the giver has a fresh grant,
   * without recreating the whole queue and losing its pending work. */
  setGrantId(grantId: string): void {
    this.grantId = grantId;
  }

  /** Enqueues a freshly picked file — the intake path, not a resume. */
  enqueue(clientPhotoId: string, source: Blob): void {
    this.track(clientPhotoId, source);
    this.pending.push(clientPhotoId);
    this.pump();
  }

  /** Re-arms a photo that failed (retryable) or needed reselection, with
   * either its still-resident source or a freshly picked replacement. */
  retry(clientPhotoId: string, source: Blob): void {
    this.enqueue(clientPhotoId, source);
  }

  /** Seeds the queue from whatever `storage.ts` has left over from a prior
   * session — see this file's header on how an interrupted `"uploading"`
   * photo and a source-less one are each handled. */
  async resume(photos: Pick<BulkDraftPhoto, "clientPhotoId" | "status">[]): Promise<void> {
    for (const photo of photos) {
      if (photo.status !== "queued" && photo.status !== "uploading") continue;
      const source = await getPhotoSource(this.driver, this.batchKey, photo.clientPhotoId);
      if (source === null) {
        this.onPhotoUpdate(photo.clientPhotoId, { needsReselection: true, hasLocalSource: false, status: "queued" });
        continue;
      }
      this.track(photo.clientPhotoId, source);
      this.pending.push(photo.clientPhotoId);
    }
    this.pump();
  }

  cancel(clientPhotoId: string): void {
    const tracked = this.tracked.get(clientPhotoId);
    tracked?.controller.abort();
    this.tracked.delete(clientPhotoId);
    this.pending = this.pending.filter((id) => id !== clientPhotoId);
  }

  destroy(): void {
    this.destroyed = true;
    for (const tracked of this.tracked.values()) tracked.controller.abort();
    this.tracked.clear();
    this.pending = [];
  }

  private track(clientPhotoId: string, source: Blob): void {
    this.tracked.get(clientPhotoId)?.controller.abort();
    this.tracked.set(clientPhotoId, { source, controller: new AbortController() });
  }

  private pump(): void {
    if (this.destroyed || this.paused !== null) return;
    while (this.pending.length > 0) {
      const clientPhotoId = this.pending.shift()!;
      const tracked = this.tracked.get(clientPhotoId);
      if (tracked === undefined) continue; // cancelled between enqueue and pump
      void this.processOne(clientPhotoId, tracked);
    }
  }

  private async processOne(clientPhotoId: string, tracked: TrackedPhoto): Promise<void> {
    const { source, controller } = tracked;
    this.onPhotoUpdate(clientPhotoId, { status: "uploading", error: null, errorCode: null, canRetry: false });

    let prepared: PreparedUpload;
    try {
      prepared = await this.decodeGate.run(() => this.prepareUpload(source, { signal: controller.signal }));
    } catch (error) {
      if (controller.signal.aborted) return;
      await this.handleFailure(clientPhotoId, classifyPhotoUploadFailure(error), source);
      return;
    }

    let release: (() => void) | undefined;
    try {
      release = await this.limiter.acquire(controller.signal);
    } catch {
      return; // aborted while waiting for a slot
    }

    try {
      const result = await this.uploadPhoto({
        clientPhotoId,
        full: prepared.full.blob,
        thumb: prepared.thumb.blob,
        width: prepared.full.width,
        height: prepared.full.height,
        blurhash: prepared.blurhash,
        signal: controller.signal,
      });

      if (result.ok) {
        this.tracked.delete(clientPhotoId);
        await dropPhotoSource(this.driver, this.batchKey, clientPhotoId);
        this.onPhotoUpdate(clientPhotoId, {
          status: "complete",
          photoId: result.data.photo_id,
          urlThumb: result.data.url_thumb,
          error: null,
          errorCode: null,
          canRetry: false,
          hasLocalSource: false,
          needsReselection: false,
        });
        this.onPhotoSynced?.(result.data);
        return;
      }

      if (controller.signal.aborted) return;

      if (result.error.kind === "throttled") {
        // Not this photo's failure — re-queue it and pause the whole
        // pipeline, per this file's header.
        this.pending.unshift(clientPhotoId);
        this.onPhotoUpdate(clientPhotoId, { status: "queued", error: null, errorCode: null, canRetry: false });
        await this.pauseFor(result.error.retryAfterSeconds);
        return;
      }

      await this.handleFailure(clientPhotoId, classifyBulkWriteFailure(result.error), source);
    } catch (error) {
      if (controller.signal.aborted) return;
      await this.handleFailure(clientPhotoId, classifyPhotoUploadFailure(error), source);
    } finally {
      release?.();
    }
  }

  private async handleFailure(clientPhotoId: string, failure: PhotoUploadFailure, source: Blob): Promise<void> {
    const status = failure.canRetry ? "retryable_failure" : "permanent_failure";
    let hasLocalSource = false;

    if (status === "permanent_failure") {
      // No retry can help — the source is never read again, same as a
      // successful upload. See storage.ts's header on why this is what
      // keeps resident bytes bounded rather than a byte cap alone.
      await dropPhotoSource(this.driver, this.batchKey, clientPhotoId);
    } else {
      // Keep the source resident (best-effort — `savePhotoSource` may still
      // refuse it under the cap, in which case the giver sees
      // `needsReselection` instead of a plain retry) so an automatic or
      // manual retry doesn't need reselection in the common case.
      const outcome = await savePhotoSource(this.driver, this.batchKey, clientPhotoId, source).catch(() => ({ stored: false }));
      hasLocalSource = outcome.stored;
    }

    this.tracked.delete(clientPhotoId);
    this.onPhotoUpdate(clientPhotoId, {
      status,
      error: failure.message,
      errorCode: failure.errorCode,
      canRetry: failure.canRetry,
      hasLocalSource,
      needsReselection: status === "retryable_failure" && !hasLocalSource,
    });
  }

  private async pauseFor(retryAfterSeconds: number): Promise<void> {
    if (this.paused !== null) {
      await this.paused;
      return;
    }
    const resumeAt = Date.now() + retryAfterSeconds * 1000;
    this.onPause?.(resumeAt);
    this.paused = this.sleep(retryAfterSeconds * 1000).then(() => {
      this.paused = null;
      this.onResume?.();
      this.pump();
    });
    await this.paused;
  }
}

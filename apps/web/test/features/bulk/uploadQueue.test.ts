import type { BatchPhotoSummary } from "@keepsake/contracts/bulk";
import { ApiError } from "@/api/client";
import { classifyBulkError, type BulkResult } from "@/api/bulk";
import type { PreparedUpload } from "@/lib/images/prepareUpload";
import { ImagePrepError } from "@/lib/images/resizeImage";
import { createMemoryDriver, getPhotoSource, savePhotoSource } from "@/features/bulk/storage";
import { RateLimiter, UploadQueue, classifyPhotoUploadFailure, type UploadPhotoFn } from "@/features/bulk/uploadQueue";
import type { BulkDraftPhoto } from "@/features/bulk/batchStore";

function preparedUpload(): PreparedUpload {
  return {
    full: { blob: new Blob(["full"]), width: 100, height: 100 },
    thumb: { blob: new Blob(["thumb"]), width: 20, height: 20 },
    blurhash: "abc",
    sourceWidth: 100,
    sourceHeight: 100,
  };
}

function photoSummary(clientPhotoId: string): BatchPhotoSummary {
  return { client_photo_id: clientPhotoId, photo_id: "01SNAPA0000000000000000000", item_client_id: null, position: 0, url_thumb: "https://x/i/1/thumb" };
}

function immediateSleep(): (ms: number) => Promise<void> {
  return () => Promise.resolve();
}

describe("classifyPhotoUploadFailure", () => {
  it("marks only a timed-out ImagePrepError retryable — a refusal (wrong format/shape) is not", () => {
    expect(classifyPhotoUploadFailure(new ImagePrepError("timed_out")).canRetry).toBe(true);
    expect(classifyPhotoUploadFailure(new ImagePrepError("decode_failed")).canRetry).toBe(false);
    expect(classifyPhotoUploadFailure(new ImagePrepError("too_many_pixels")).canRetry).toBe(false);
  });

  it("treats an unrecognized thrown value as retryable rather than dead-ending the giver", () => {
    expect(classifyPhotoUploadFailure(new Error("boom")).canRetry).toBe(true);
  });
});

describe("RateLimiter", () => {
  it("grants immediately while under both the concurrency and per-minute ceilings", async () => {
    const limiter = new RateLimiter({ maxConcurrent: 2, maxPerMinute: 10 });
    const release = await limiter.acquire();
    expect(typeof release).toBe("function");
  });

  it("blocks a third acquire when maxConcurrent is 2, until one of the first two releases", async () => {
    const limiter = new RateLimiter({ maxConcurrent: 2, maxPerMinute: 10 });
    const releaseA = await limiter.acquire();
    await limiter.acquire();

    let thirdGranted = false;
    const third = limiter.acquire().then((release) => {
      thirdGranted = true;
      return release;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(thirdGranted).toBe(false);

    releaseA();
    await third;
    expect(thirdGranted).toBe(true);
  });

  it("paces starts against maxPerMinute using an injected clock, independent of concurrency", async () => {
    let now = 0;
    const limiter = new RateLimiter({ maxConcurrent: 10, maxPerMinute: 1 }, () => now);

    const releaseA = await limiter.acquire();
    releaseA(); // free the concurrency slot immediately — only the per-minute window should still block

    let secondGranted = false;
    const second = limiter.acquire().then((release) => {
      secondGranted = true;
      release();
    });
    await Promise.resolve();
    expect(secondGranted).toBe(false);

    // Still inside the 60s window: nothing to grant yet.
    now = 59_000;
    limiter.updateConfig({}); // re-pump with the same config, at the new "time"
    await Promise.resolve();
    expect(secondGranted).toBe(false);

    // Past the window: the earlier start ages out and the waiter is granted.
    now = 61_000;
    limiter.updateConfig({});
    await second;
    expect(secondGranted).toBe(true);
  });

  it("updateConfig can raise maxConcurrent at runtime and immediately grants a waiter that unblocks", async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1, maxPerMinute: 10 });
    await limiter.acquire();

    let granted = false;
    const waiter = limiter.acquire().then(() => {
      granted = true;
    });
    await Promise.resolve();
    expect(granted).toBe(false);

    limiter.updateConfig({ maxConcurrent: 2 });
    await waiter;
    expect(granted).toBe(true);
  });

  it("rejects an already-aborted signal without consuming a slot, even when one is free", async () => {
    // The free-slot case is the one that bites: `addEventListener("abort")`
    // never fires for a signal that aborted before the listener existed, so
    // an acquire that only checked on the waiting path handed cancelled
    // work a slot and let it start.
    const limiter = new RateLimiter({ maxConcurrent: 2, maxPerMinute: 10 });
    const controller = new AbortController();
    controller.abort();

    await expect(limiter.acquire(controller.signal)).rejects.toMatchObject({ name: "AbortError" });

    // Both slots are still there: two fresh acquires resolve.
    await limiter.acquire();
    await limiter.acquire();
    let thirdGranted = false;
    void limiter.acquire().then(() => {
      thirdGranted = true;
    });
    await Promise.resolve();
    expect(thirdGranted).toBe(false);
  });

  it("detaches the abort listener from a signal once its waiter is granted", async () => {
    // A batch-wide signal would otherwise collect one listener per photo:
    // `{ once: true }` clears a listener when it fires, not when the wait it
    // guards ends.
    const limiter = new RateLimiter({ maxConcurrent: 1, maxPerMinute: 10 });
    const controller = new AbortController();
    const removeSpy = jest.spyOn(controller.signal, "removeEventListener");

    const releaseFirst = await limiter.acquire();
    const second = limiter.acquire(controller.signal);
    await Promise.resolve();
    releaseFirst();
    await second;

    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));

    // And the granted acquire is not disturbed by a later abort of that
    // same signal — no unhandled rejection, no double release.
    controller.abort();
    await Promise.resolve();
  });
});

describe("UploadQueue", () => {
  it("uploads a queued photo end to end: decode -> upload -> complete, and drops its resident source", async () => {
    const driver = createMemoryDriver();
    await savePhotoSource(driver, "batch-1", "photo-a", new Blob(["source"]));

    const updates: [string, Partial<BulkDraftPhoto>][] = [];
    const uploadPhoto: UploadPhotoFn = async () => ({ ok: true, data: photoSummary("photo-a") });

    const queue = new UploadQueue({
      batchKey: "batch-1",
      driver,
      uploadPhoto,
      prepareUpload: async () => preparedUpload(),
      onPhotoUpdate: (id, patch) => updates.push([id, patch]),
    });

    queue.enqueue("photo-a", new Blob(["source"]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const statuses = updates.filter(([id]) => id === "photo-a").map(([, patch]) => patch.status);
    expect(statuses).toEqual(["uploading", "complete"]);
    expect(await getPhotoSource(driver, "batch-1", "photo-a")).toBeNull();
  });

  it("never runs two prepareUpload calls concurrently, however many photos are enqueued at once", async () => {
    const driver = createMemoryDriver();
    let concurrentDecodes = 0;
    let maxObservedConcurrency = 0;

    const queue = new UploadQueue({
      batchKey: "batch-1",
      driver,
      uploadPhoto: async () => ({ ok: true, data: photoSummary("x") }) as BulkResult<BatchPhotoSummary>,
      prepareUpload: async () => {
        concurrentDecodes += 1;
        maxObservedConcurrency = Math.max(maxObservedConcurrency, concurrentDecodes);
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrentDecodes -= 1;
        return preparedUpload();
      },
      onPhotoUpdate: () => {},
    });

    queue.enqueue("a", new Blob(["1"]));
    queue.enqueue("b", new Blob(["2"]));
    queue.enqueue("c", new Blob(["3"]));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(maxObservedConcurrency).toBe(1);
  });

  it("a retryable failure (network) keeps the photo's source resident for a follow-up retry", async () => {
    const driver = createMemoryDriver();
    const updates: Partial<BulkDraftPhoto>[] = [];

    const queue = new UploadQueue({
      batchKey: "batch-1",
      driver,
      uploadPhoto: async () => ({ ok: false, error: classifyBulkError(new ApiError("unavailable", "offline", 0)) }),
      prepareUpload: async () => preparedUpload(),
      onPhotoUpdate: (_id, patch) => updates.push(patch),
    });

    queue.enqueue("photo-a", new Blob(["source"]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const last = updates.at(-1);
    expect(last).toMatchObject({ status: "retryable_failure", canRetry: true });
    expect(await getPhotoSource(driver, "batch-1", "photo-a")).not.toBeNull();
  });

  it("a permanent failure (400) drops the resident source — retrying the same bytes would fail identically", async () => {
    const driver = createMemoryDriver();
    const updates: Partial<BulkDraftPhoto>[] = [];

    const queue = new UploadQueue({
      batchKey: "batch-1",
      driver,
      uploadPhoto: async () => ({ ok: false, error: classifyBulkError(new ApiError("bad_request", "Malformed image.", 400)) }),
      prepareUpload: async () => preparedUpload(),
      onPhotoUpdate: (_id, patch) => updates.push(patch),
    });

    queue.enqueue("photo-a", new Blob(["source"]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(updates.at(-1)).toMatchObject({ status: "permanent_failure", canRetry: false });
    expect(await getPhotoSource(driver, "batch-1", "photo-a")).toBeNull();
  });

  it("a throttled (429 + Retry-After) response pauses the queue and re-queues the photo instead of failing it", async () => {
    const driver = createMemoryDriver();
    const updates: Partial<BulkDraftPhoto>[] = [];
    let calls = 0;
    let paused = false;
    let resumed = false;

    const uploadPhoto: UploadPhotoFn = async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: false, error: classifyBulkError(new ApiError("rate_limited", "Slow down", 429, 30)) };
      }
      return { ok: true, data: photoSummary("photo-a") };
    };

    const queue = new UploadQueue({
      batchKey: "batch-1",
      driver,
      uploadPhoto,
      prepareUpload: async () => preparedUpload(),
      onPhotoUpdate: (_id, patch) => updates.push(patch),
      onPause: () => {
        paused = true;
      },
      onResume: () => {
        resumed = true;
      },
      sleep: immediateSleep(),
    });

    queue.enqueue("photo-a", new Blob(["source"]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(paused).toBe(true);
    expect(resumed).toBe(true);
    expect(calls).toBe(2);
    expect(updates.some((p) => p.status === "permanent_failure" || p.status === "retryable_failure")).toBe(false);
    expect(updates.at(-1)?.status).toBe("complete");
  });

  // The daily ceilings answer 429 with `Retry-After: <seconds until UTC
  // midnight>`, which is the same shape as the burst brake's and can be most
  // of a day. Classified as a pause, it would park the whole queue silently
  // until midnight — no failed tile, nothing to tell the giver. It has to
  // fail the photo instead, which is what `MAX_PAUSE_SECONDS` decides.
  it("a 429 whose Retry-After runs to UTC midnight fails the photo rather than pausing the queue for hours", async () => {
    const driver = createMemoryDriver();
    const updates: Partial<BulkDraftPhoto>[] = [];
    let calls = 0;
    let paused = false;

    const uploadPhoto: UploadPhotoFn = async () => {
      calls += 1;
      return {
        ok: false,
        error: classifyBulkError(
          new ApiError("rate_limited", "Today's photo limit for this account has been reached.", 429, 33_000),
        ),
      };
    };

    const queue = new UploadQueue({
      batchKey: "batch-1",
      driver,
      uploadPhoto,
      prepareUpload: async () => preparedUpload(),
      onPhotoUpdate: (_id, patch) => updates.push(patch),
      onPause: () => {
        paused = true;
      },
      sleep: immediateSleep(),
    });

    queue.enqueue("photo-a", new Blob(["source"]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(paused).toBe(false);
    expect(calls).toBe(1);
    expect(updates.at(-1)).toMatchObject({ status: "permanent_failure", errorCode: "limit_reached", canRetry: false });
    expect(updates.at(-1)?.error).toContain("Today's photo limit");
  });

  it("resume() re-queues a persisted queued/uploading photo whose source survived, and requests reselection for one that didn't", async () => {
    const driver = createMemoryDriver();
    await savePhotoSource(driver, "batch-1", "has-source", new Blob(["still here"]));
    // "lost-source" has no blob in the driver at all — simulating browser eviction.

    const updates: [string, Partial<BulkDraftPhoto>][] = [];
    const uploadPhoto: UploadPhotoFn = async ({ clientPhotoId }) => ({ ok: true, data: photoSummary(clientPhotoId) });

    const queue = new UploadQueue({
      batchKey: "batch-1",
      driver,
      uploadPhoto,
      prepareUpload: async () => preparedUpload(),
      onPhotoUpdate: (id, patch) => updates.push([id, patch]),
    });

    await queue.resume([
      { clientPhotoId: "has-source", status: "queued" },
      { clientPhotoId: "lost-source", status: "uploading" },
      { clientPhotoId: "already-done", status: "complete" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const lostSourceUpdates = updates.filter(([id]) => id === "lost-source").map(([, patch]) => patch);
    expect(lostSourceUpdates).toEqual([{ needsReselection: true, hasLocalSource: false, status: "queued" }]);

    const hasSourceUpdates = updates.filter(([id]) => id === "has-source").map(([, patch]) => patch.status);
    expect(hasSourceUpdates).toEqual(["uploading", "complete"]);

    expect(updates.some(([id]) => id === "already-done")).toBe(false);
  });

  it("updateLimits is accepted at runtime without recreating the queue", () => {
    const driver = createMemoryDriver();
    const queue = new UploadQueue({
      batchKey: "batch-1",
      driver,
      uploadPhoto: async () => ({ ok: true, data: photoSummary("x") }),
      onPhotoUpdate: () => {},
    });
    expect(() => queue.updateLimits({ maxConcurrent: 5, maxPerMinute: 40 })).not.toThrow();
  });

  it("destroy() aborts in-flight work and stops the queue from continuing", async () => {
    const driver = createMemoryDriver();
    let uploadCalls = 0;
    const updates: Partial<BulkDraftPhoto>[] = [];

    const queue = new UploadQueue({
      batchKey: "batch-1",
      driver,
      uploadPhoto: async () => {
        uploadCalls += 1;
        return { ok: true, data: photoSummary("photo-a") };
      },
      prepareUpload: (_source, { signal }) =>
        new Promise((resolve, reject) => {
          // Real abortable work (`resizeImage.ts`'s `throwIfAborted`) rejects
          // immediately for a signal that's already aborted by the time it's
          // reached, not only on a future 'abort' event — mirrored here so
          // this fixture behaves like the real pipeline `destroy()` races.
          if (signal?.aborted === true) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          const timer = setTimeout(() => resolve(preparedUpload()), 20);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
      onPhotoUpdate: (_id, patch) => updates.push(patch),
    });

    queue.enqueue("photo-a", new Blob(["source"]));
    queue.destroy();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(uploadCalls).toBe(0);
    expect(updates.some((p) => p.status === "complete")).toBe(false);
  });
});

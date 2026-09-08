/**
 * Log hygiene for the bulk submission runner (`src/bulk/submit.ts`,
 * `src/cron/bulkRunner.ts`) — the plan's rule that operational logs never
 * carry a raw story, filename, address or credential.
 *
 * Both files' `catch` blocks log a plain diagnostic line with the caught
 * error's `.message` right next to a `captureException(err, ...)` call.
 * `captureException` already redacts (`@keepsake/observability/capture`
 * runs every message through `redactString` before it reaches
 * `console.error`/`console.warn`) — but that redaction is a property of
 * `capture.ts`, not of these two bare `console.error` lines sitting beside
 * it. An exception on this path is thrown from deep inside a D1 batch or a
 * fetch while operating on a draft item's assembled title/story/aspects —
 * exactly the private, giver-authored text the log-hygiene rule exists to
 * keep out of Workers Logs — so nothing here may assume the message is
 * always safe to print verbatim.
 *
 * `redactedErrorMessage` (exported from `submit.ts`) is the fix: both
 * `console.error` call sites route the caught error's message through it
 * before logging. These tests prove the wiring, not just the redaction
 * helper's own regex — a caller could pass `err.message` around it and
 * still compile.
 */
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubmitBatchInput } from "@keepsake/contracts/bulk";
import { redactedErrorMessage, runBulkOperation, startSubmission } from "../src/bulk/submit.js";
import { bulkRunner } from "../src/cron/bulkRunner.js";
import { ulid } from "../src/lib/ids.js";
import { insertOwner } from "./helpers.js";

/** A message shaped like the kind of thing that must never reach a log line
 * verbatim: an email address (the plan's own "no addresses" example) and a
 * token-shaped credential in the same string, so one assertion covers both
 * of `redactString`'s relevant rules. */
const SENSITIVE_MESSAGE = "D1 write failed for giver mum@example.com, owner_token=s3cr3t-do-not-log";

async function insertBatch(ownerId: string): Promise<string> {
  const id = ulid();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO upload_batches
       (id, owner_id, client_batch_key, name, shared_story, country, postal_code, place_name, admin1, lat, lng,
        state, revision, last_activity_at, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, 'Test batch', NULL, 'US', '02144', 'Somerville', 'MA', 42.3958, -71.0967,
             'draft', 1, ?, ?, ?, ?)`,
  )
    .bind(id, ownerId, `client-${id}`, now, now + 7 * 24 * 60 * 60 * 1000, now, now)
    .run();
  return id;
}

async function insertItem(batchId: string, clientItemId: string): Promise<{ id: string; revision: number }> {
  const id = ulid();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO upload_batch_items
       (id, batch_id, client_item_id, title, story, category, aspects_json, room_label, lot_label, state, revision, created_at, updated_at)
     VALUES (?, ?, ?, 'A lovely teacup', 'This belonged to my grandmother and I would love for it to find a new home.',
             'home_kitchen', NULL, NULL, NULL, 'ready', 1, ?, ?)`,
  )
    .bind(id, batchId, clientItemId, now, now)
    .run();
  return { id, revision: 1 };
}

async function insertPhoto(ownerId: string): Promise<string> {
  const id = ulid();
  const now = Date.now();
  const fullKey = `photos/${id}/full.jpg`;
  const thumbKey = `photos/${id}/thumb.jpg`;
  await env.BUCKET.put(fullKey, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
  await env.BUCKET.put(thumbKey, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
  await env.DB.prepare(
    `INSERT INTO photos
       (id, owner_id, listing_id, position, r2_key_full, r2_key_thumb, width, height, bytes_full, blurhash, content_type, moderation_status, created_at)
     VALUES (?, ?, NULL, NULL, ?, ?, 800, 600, 12345, 'LEHV6nl01waF5-KStrzX', 'image/jpeg', 'unchecked', ?)`,
  )
    .bind(id, ownerId, fullKey, thumbKey, now)
    .run();
  return id;
}

async function attachPhoto(batchId: string, itemId: string, photoId: string, clientPhotoId: string): Promise<void> {
  const id = ulid();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO upload_batch_photos (id, batch_id, client_photo_id, photo_id, item_id, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(id, batchId, clientPhotoId, photoId, itemId, now, now)
    .run();
}

function validDateOfBirth(): string {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 30);
  return date.toISOString().slice(0, 10);
}

function submitInput(opKey: string, items: { client_item_id: string; revision: number }[]): SubmitBatchInput {
  return { op_key: opKey, date_of_birth: validDateOfBirth(), items };
}

/** Every string this suite hands `console.error`'s spy back, concatenated,
 * so an assertion doesn't have to guess which argument position the
 * sensitive text might have leaked into. */
function loggedText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((call: unknown[]) => JSON.stringify(call)).join("\n");
}

describe("bulk log hygiene: redactedErrorMessage", () => {
  it("strips an email local-part and a token-shaped credential", () => {
    const redacted = redactedErrorMessage(new Error(SENSITIVE_MESSAGE));
    expect(redacted).not.toContain("mum@example.com");
    expect(redacted).not.toContain("s3cr3t-do-not-log");
    expect(redacted).toContain("[REDACTED]");
  });

  it("handles a thrown non-Error the same way", () => {
    const redacted = redactedErrorMessage(SENSITIVE_MESSAGE);
    expect(redacted).not.toContain("mum@example.com");
    expect(redacted).not.toContain("s3cr3t-do-not-log");
  });
});

describe("bulk log hygiene: runBulkOperation's own console.error", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never prints a caught error's raw message", async () => {
    const ownerId = await insertOwner();
    const batchId = await insertBatch(ownerId);
    const item = await insertItem(batchId, "item-1");
    await attachPhoto(batchId, item.id, await insertPhoto(ownerId), "photo-1");

    const started = await startSubmission(env, {
      ownerId,
      batchId,
      input: submitInput("submit-log-hygiene-1", [{ client_item_id: "item-1", revision: item.revision }]),
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    // Force the checkpoint write inside `runBulkOperation`'s own try block to
    // throw a message shaped like real leaked content, without disturbing
    // any other query the run makes.
    const originalPrepare = env.DB.prepare.bind(env.DB);
    const prepareSpy = vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("SET cursor = ?")) {
        throw new Error(SENSITIVE_MESSAGE);
      }
      return originalPrepare(sql);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runBulkOperation(env, started.operation.id);

    prepareSpy.mockRestore();

    expect(errorSpy).toHaveBeenCalled();
    const text = loggedText(errorSpy);
    expect(text).not.toContain("mum@example.com");
    expect(text).not.toContain("s3cr3t-do-not-log");
    expect(text).toContain("[REDACTED]");
  });
});

describe("bulk log hygiene: cron bulkRunner's own console.error", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never prints a caught error's raw message when runBulkOperation throws before its own try block", async () => {
    const ownerId = await insertOwner();
    const batchId = await insertBatch(ownerId);
    const now = Date.now();
    const operationId = ulid();

    // A bare `bulk_operations` row, due now — enough for `bulkRunner`'s
    // candidate query to pick it up. `runBulkOperation`'s claim UPDATE (the
    // very first statement it runs, outside its own try/catch) is what this
    // test makes throw, so the exception can only be caught by the cron
    // dispatcher's own catch in `src/cron/bulkRunner.ts`.
    await env.DB.prepare(
      `INSERT INTO bulk_operations
         (id, owner_id, batch_id, kind, op_key, payload_hash, selection_json,
          status, cursor, total, succeeded, failed, attempts, lease_until,
          next_attempt_at, age_attested_at, created_at, updated_at, finished_at)
       VALUES (?, ?, ?, 'submit', 'log-hygiene-op', 'hash', '[]', 'queued', 0, 0, 0, 0, 0, NULL, ?, ?, ?, ?, NULL)`,
    )
      .bind(operationId, ownerId, batchId, now, now, now, now)
      .run();

    const originalPrepare = env.DB.prepare.bind(env.DB);
    const prepareSpy = vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      if (sql.includes("SET status = 'running'")) {
        throw new Error(SENSITIVE_MESSAGE);
      }
      return originalPrepare(sql);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await bulkRunner(env);

    prepareSpy.mockRestore();

    expect(errorSpy).toHaveBeenCalled();
    const text = loggedText(errorSpy);
    expect(text).not.toContain("mum@example.com");
    expect(text).not.toContain("s3cr3t-do-not-log");
    expect(text).toContain("[REDACTED]");
  });
});

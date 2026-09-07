/**
 * `moderateListing(env, listingId, version)` — the orchestrator described in
 * the plan's "Moderation pipeline" section. Called from `waitUntil()` right
 * after a listing is created or edited, and again by
 * `src/cron/moderationRetry.ts` for anything still `pending` a few minutes
 * later. Every call is self-contained: it re-derives the retry attempt
 * number from `moderation_events` rather than taking one as a parameter, so
 * every caller has the same simple two-line contract.
 */
import type { Env } from "../env.js";
import { MODELS } from "../models.js";
import { ulid } from "../lib/ids.js";
import { checkAndBump } from "./budget.js";
import { parseIntVar } from "../env.js";
import { moderateText } from "./text.js";
import { isImageError, moderateImage } from "./image.js";
import { decide, decideImage, decideText } from "./decide.js";
import { containsContactInfo } from "./contactInfo.js";

/** After this many failed attempts (AI errors, exhausted budget, timeouts —
 * anything that would otherwise retry forever) a listing is escalated to
 * `needs_review` instead of retried again. */
const MAX_ATTEMPTS = 3;

const DEFAULT_TEXT_DAILY_BUDGET = 1000;
const DEFAULT_IMAGE_DAILY_BUDGET = 3000;

interface ListingRow {
  id: string;
  title: string;
  story: string;
  version: number;
}

interface PhotoRow {
  id: string;
  r2_key_thumb: string;
}

interface LogEventFields {
  listingId: string;
  listingVersion: number;
  photoId?: string | undefined;
  kind: "text" | "image" | "decision";
  model?: string | undefined;
  verdict: string;
  flagsJson?: string | undefined;
  reason?: string | undefined;
  attempt: number;
  latencyMs?: number | undefined;
}

async function logEvent(env: Env, fields: LogEventFields): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO moderation_events
      (id, listing_id, listing_version, photo_id, kind, model, verdict, flags_json, reason, attempt, latency_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      ulid(),
      fields.listingId,
      fields.listingVersion,
      fields.photoId ?? null,
      fields.kind,
      fields.model ?? null,
      fields.verdict,
      fields.flagsJson ?? null,
      fields.reason ?? null,
      fields.attempt,
      fields.latencyMs ?? null,
      Date.now(),
    )
    .run();
}

async function nextAttemptNumber(env: Env, listingId: string, version: number): Promise<number> {
  const last = await env.DB.prepare(
    `SELECT attempt FROM moderation_events
     WHERE listing_id = ? AND listing_version = ? AND kind = 'decision'
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(listingId, version)
    .first<{ attempt: number }>();
  return (last?.attempt ?? 0) + 1;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function setStatus(
  env: Env,
  listingId: string,
  version: number,
  fields: { status: string; moderationReason: string | null; publishIfUnset: boolean },
): Promise<void> {
  const now = Date.now();
  if (fields.publishIfUnset) {
    await env.DB.prepare(
      `UPDATE listings SET status = ?, moderation_reason = ?, updated_at = ?, published_at = COALESCE(published_at, ?)
       WHERE id = ? AND version = ?`,
    )
      .bind(fields.status, fields.moderationReason, now, now, listingId, version)
      .run();
  } else {
    await env.DB.prepare("UPDATE listings SET status = ?, moderation_reason = ?, updated_at = ? WHERE id = ? AND version = ?")
      .bind(fields.status, fields.moderationReason, now, listingId, version)
      .run();
  }
}

export async function moderateListing(env: Env, listingId: string, version: number): Promise<void> {
  const listing = await env.DB.prepare("SELECT id, title, story, version FROM listings WHERE id = ?")
    .bind(listingId)
    .first<ListingRow>();

  // Deleted, or superseded by an edit that bumped the version since this run
  // was scheduled — nothing for this run to do.
  if (!listing || listing.version !== version) return;

  const attempt = await nextAttemptNumber(env, listingId, version);

  if (attempt > MAX_ATTEMPTS) {
    await logEvent(env, {
      listingId,
      listingVersion: version,
      kind: "decision",
      verdict: "needs_review",
      reason: "held_for_review",
      attempt,
    });
    await setStatus(env, listingId, version, {
      status: "needs_review",
      moderationReason: "held_for_review",
      publishIfUnset: false,
    });
    return;
  }

  // Step 1: local checks. Title/story length, category enum, and photo
  // count (1-5) are already enforced by CreateListingInput/UpdateListingInput
  // at the API boundary — only the contact-info regex needs re-checking here.
  if (containsContactInfo(`${listing.title}\n${listing.story}`)) {
    await logEvent(env, {
      listingId,
      listingVersion: version,
      kind: "decision",
      verdict: "rejected",
      reason: "contact_in_story",
      attempt,
    });
    await setStatus(env, listingId, version, {
      status: "rejected",
      moderationReason: "contact_in_story",
      publishIfUnset: false,
    });
    return;
  }

  const { results: photos } = await env.DB.prepare("SELECT id, r2_key_thumb FROM photos WHERE listing_id = ? ORDER BY position")
    .bind(listingId)
    .all<PhotoRow>();

  // Step 2: budget gate. Denied → stays pending, cron retries after the
  // ceiling resets at midnight UTC.
  const textDailyLimit = parseIntVar("MOD_TEXT_DAILY_BUDGET", env.MOD_TEXT_DAILY_BUDGET, DEFAULT_TEXT_DAILY_BUDGET);
  const textBudget = await checkAndBump(env.KV, { kind: "mod_text", dailyLimit: textDailyLimit });
  if (!textBudget.allowed) {
    await logEvent(env, { listingId, listingVersion: version, kind: "decision", verdict: "error", reason: "budget", attempt });
    return;
  }

  if (photos.length > 0) {
    const imageDailyLimit = parseIntVar("MOD_IMAGE_DAILY_BUDGET", env.MOD_IMAGE_DAILY_BUDGET, DEFAULT_IMAGE_DAILY_BUDGET);
    const imageBudget = await checkAndBump(env.KV, { kind: "mod_image", dailyLimit: imageDailyLimit });
    if (!imageBudget.allowed) {
      await logEvent(env, { listingId, listingVersion: version, kind: "decision", verdict: "error", reason: "budget", attempt });
      return;
    }
  }

  // Step 3: text.
  const textStart = Date.now();
  const textVerdict = await moderateText(env, listing.title, listing.story);
  await logEvent(env, {
    listingId,
    listingVersion: version,
    kind: "text",
    model: MODELS.textGuard,
    verdict: decideText(textVerdict),
    flagsJson: textVerdict !== "error" && textVerdict.verdict === "unsafe" ? JSON.stringify(textVerdict.codes) : undefined,
    attempt,
    latencyMs: Date.now() - textStart,
  });

  // Step 4: images, one Workers AI call per photo, in parallel.
  const imageVerdicts = await Promise.all(
    photos.map(async (photo) => {
      const object = await env.BUCKET.get(photo.r2_key_thumb);
      if (!object) {
        await logEvent(env, {
          listingId,
          listingVersion: version,
          photoId: photo.id,
          kind: "image",
          model: MODELS.imageVision,
          verdict: "error",
          reason: "thumb_missing",
          attempt,
        });
        return "error" as const;
      }

      const imageStart = Date.now();
      const base64 = arrayBufferToBase64(await object.arrayBuffer());
      const contentType = object.httpMetadata?.contentType ?? "image/jpeg";
      const outcome = await moderateImage(env, base64, contentType);
      const verdict = isImageError(outcome) ? ("error" as const) : outcome;
      await logEvent(env, {
        listingId,
        listingVersion: version,
        photoId: photo.id,
        kind: "image",
        model: MODELS.imageVision,
        verdict: decideImage(verdict),
        reason: isImageError(outcome) ? outcome.error : undefined,
        flagsJson: isImageError(outcome) ? undefined : JSON.stringify(outcome),
        attempt,
        latencyMs: Date.now() - imageStart,
      });
      return verdict;
    }),
  );

  // Step 5: decide.
  const decision = decide(textVerdict, imageVerdicts);

  if (decision.status === "pending") {
    await logEvent(env, { listingId, listingVersion: version, kind: "decision", verdict: "error", attempt });
    return;
  }

  if (decision.status === "rejected") {
    await logEvent(env, { listingId, listingVersion: version, kind: "decision", verdict: "rejected", reason: decision.reason, attempt });
    await setStatus(env, listingId, version, { status: "rejected", moderationReason: decision.reason, publishIfUnset: false });
    return;
  }

  if (decision.status === "needs_review") {
    await logEvent(env, { listingId, listingVersion: version, kind: "decision", verdict: "needs_review", reason: "held_for_review", attempt });
    await setStatus(env, listingId, version, { status: "needs_review", moderationReason: "held_for_review", publishIfUnset: false });
    return;
  }

  // Approved. `published_at` is set once and never overwritten by a later
  // re-approval (e.g. after an edit is re-moderated) — guarded by
  // COALESCE(published_at, ...) inside setStatus.
  await logEvent(env, { listingId, listingVersion: version, kind: "decision", verdict: "approved", attempt });
  await setStatus(env, listingId, version, { status: "approved", moderationReason: null, publishIfUnset: true });
}

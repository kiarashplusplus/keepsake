/**
 * `moderateListing(env, listingId, version, clientIP?)` — the orchestrator
 * described in the plan's "Moderation pipeline" section. Called from
 * `waitUntil()` right after a listing is created or edited (with the
 * creating/editing request's IP, so the budget-floor check in step 2 knows
 * who's asking), and again by `src/cron/moderationRetry.ts` for anything
 * still `pending` a few minutes later (with no IP — the cron has no request
 * to read one from, so those retries are never eligible for the reserved
 * floor and only draw from the general pool). Every call is otherwise
 * self-contained: it re-derives the retry attempt number from
 * `moderation_events` rather than taking one as a parameter, so every
 * caller has the same simple contract.
 */
import { captureMessage } from "@keepsake/observability/capture";
import type { Env } from "../env.js";
import { MODELS } from "../models.js";
import { ulid } from "../lib/ids.js";
import { checkAndBump, todayISO } from "./budget.js";
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
// Charged once per photo (`cost: photos.length` below), not once per
// listing — see the `checkAndBump` `cost` doc comment and issue #18. Before
// this fix the configured number was charged once per listing while the
// pipeline made up to five vision calls per listing, so the true ceiling
// was five times the configured one and nobody could tell from reading
// `wrangler.toml`.
const DEFAULT_IMAGE_DAILY_BUDGET = 3000;

// Issue #18: slice of each global moderation budget held back from the
// general pool, reachable only by a caller whose own usage of that budget
// today is still under `FRESH_CALLER_CEILING` — see `checkAndBump`'s
// `reservedFloor`/`freshCallerCeiling` doc comment for the full rationale.
// 10% is a guess, not a measurement: there's no production traffic yet to
// size it against (the same gap the launch audit called out for the
// ceilings themselves), so it's picked to be big enough to matter without
// giving up most of the day's headroom to a floor that, on a normal day,
// nothing ever needs.
const RESERVED_FLOOR_RATIO = 0.1;
// A giver posting "a few keepsakes a day" (the budget doc's own framing)
// stays well under this; an address that has already caused this many
// mod_text/mod_image checks today looks like the same burst that drained
// the general pool, not a second unlucky giver.
const FRESH_CALLER_CEILING = 3;

/**
 * Fires a warning log the first time either global moderation budget is
 * exhausted on a given UTC day (issue #18) — before this, a queue quietly
 * filling up with `pending`/`reason=budget` listings had no corresponding
 * alert, so a launch-day traffic spike and a deliberate attack looked
 * identical from the outside and neither paged anyone. Read-then-write
 * against KV rather than a real CAS, same tradeoff `checkAndBump` itself
 * documents: two concurrent exhaustions on the same day could in theory
 * both slip through and double-fire, which is a firm no-op compared to the
 * alternative of missing it, so it's accepted rather than built around.
 *
 * Previously a no-op with `SENTRY_DSN` unset (issue #14) — `captureMessage`
 * now writes straight to Workers Logs, no DSN or account to provision.
 */
async function alertBudgetExhaustedOnce(env: Env, kind: "mod_text" | "mod_image"): Promise<void> {
  const key = `budget:alerted:${kind}:${todayISO()}`;
  const alreadyAlerted = await env.KV.get(key);
  if (alreadyAlerted) return;
  await env.KV.put(key, "1", { expirationTtl: 172_800 });
  captureMessage(`Moderation budget exhausted for ${kind} today`, "warning");
}

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

export async function moderateListing(env: Env, listingId: string, version: number, clientIP?: string): Promise<void> {
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
  // ceiling resets at midnight UTC. Both checks reserve a floor (issue #18)
  // that only a caller who hasn't already used much of *this* budget today
  // can draw on, and both persist `moderation_reason = 'budget'` on the
  // listing (rather than only logging it) so the owner-facing API already
  // tells the truth about why a listing is taking longer than usual — see
  // `serializeOwnerListing`/`GET /api/me/listings(/:id)`, which return
  // `moderation_reason` regardless of status, not only for `rejected`.
  const textDailyLimit = parseIntVar("MOD_TEXT_DAILY_BUDGET", env.MOD_TEXT_DAILY_BUDGET, DEFAULT_TEXT_DAILY_BUDGET);
  const textBudget = await checkAndBump(env.KV, {
    kind: "mod_text",
    dailyLimit: textDailyLimit,
    ...(clientIP !== undefined ? { clientIP } : {}),
    reservedFloor: Math.floor(textDailyLimit * RESERVED_FLOOR_RATIO),
    freshCallerCeiling: FRESH_CALLER_CEILING,
  });
  if (!textBudget.allowed) {
    await logEvent(env, { listingId, listingVersion: version, kind: "decision", verdict: "error", reason: "budget", attempt });
    await setStatus(env, listingId, version, { status: "pending", moderationReason: "budget", publishIfUnset: false });
    await alertBudgetExhaustedOnce(env, "mod_text");
    return;
  }

  if (photos.length > 0) {
    const imageDailyLimit = parseIntVar("MOD_IMAGE_DAILY_BUDGET", env.MOD_IMAGE_DAILY_BUDGET, DEFAULT_IMAGE_DAILY_BUDGET);
    const imageBudget = await checkAndBump(env.KV, {
      kind: "mod_image",
      dailyLimit: imageDailyLimit,
      cost: photos.length,
      ...(clientIP !== undefined ? { clientIP } : {}),
      reservedFloor: Math.floor(imageDailyLimit * RESERVED_FLOOR_RATIO),
      freshCallerCeiling: FRESH_CALLER_CEILING,
    });
    if (!imageBudget.allowed) {
      await logEvent(env, { listingId, listingVersion: version, kind: "decision", verdict: "error", reason: "budget", attempt });
      await setStatus(env, listingId, version, { status: "pending", moderationReason: "budget", publishIfUnset: false });
      await alertBudgetExhaustedOnce(env, "mod_image");
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

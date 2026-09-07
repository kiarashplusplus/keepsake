/**
 * AI autofill for the give flow: one Workers AI vision call against a
 * photo's R2 thumb, run synchronously from `POST /api/photos/:id/suggest` —
 * on demand, never at upload time. (The give-flow plan's Part 3 explains why
 * upload-time generation was rejected: nothing sweeps a stranded suggestion,
 * "first photo" breaks under reordering, and it would have needed a
 * migration for a feature that's allowed to just fail quietly.)
 *
 * Mirrors `moderation/image.ts`'s call/parse/retry shape on purpose: the
 * same base64-encode-the-thumb step, the same "a text part is required
 * alongside the image" workaround, the same `extractResponseText`
 * normalisation for the Workers AI quirk where `response` comes back as a
 * *parsed object* rather than a string, and one retry on a parse failure
 * before giving up. The one real difference is what giving up means: a
 * moderation failure holds a listing `pending` for the cron to retry — a
 * fail-closed safety gate. A suggestion failure is a non-event: the giver
 * just gets an empty, already-usable form, exactly as if autofill didn't
 * exist. This module never throws for that reason.
 */
import { PhotoSuggestionSchema, type PhotoSuggestion } from "@keepsake/contracts/photo";
import type { Env } from "../env.js";
import { isMockAi } from "../env.js";
import { MODELS } from "../models.js";
import { withTimeout } from "../lib/withTimeout.js";
import { SUGGEST_RETRY_INSTRUCTION, SUGGEST_SYSTEM_PROMPT, SUGGEST_USER_PROMPT } from "./prompts.js";

// Half of moderation's per-call image timeout (30s, moderation/image.ts).
// Autofill is a nice-to-have racing the giver moving on to the next step of
// the form, not a safety gate a listing's publish state depends on — if the
// model isn't back quickly the form is already usable without it, so there
// is no reason to make anyone wait as long as moderation is willing to.
const TIMEOUT_MS = 15_000;
const MAX_TOKENS = 200;

const MOCK_SUGGESTION: PhotoSuggestion = {
  subject: "a ceramic mug",
  title: "Blue ceramic mug",
  category: "home_kitchen",
  condition: "small chip near the handle",
  aspects: [
    { name: "object", value: "mug" },
    { name: "material", value: "ceramic" },
    { name: "colour", value: "blue" },
  ],
};

export type SuggestResult = { suggestion: PhotoSuggestion } | { suggestion: null; reason: string };

function stripCodeFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
}

function tryParseSuggestion(text: string): PhotoSuggestion | null {
  try {
    const parsed: unknown = JSON.parse(stripCodeFences(text));
    const result = PhotoSuggestionSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Workers AI returns `response` as a string normally, but when the model
 * emits a JSON object it hands back the *parsed object* (see
 * `moderation/image.ts`, observed on preview 2026-09-05). Normalise both to
 * text so the parser downstream sees one shape.
 */
function extractResponseText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "response" in result) {
    const response = (result as { response: unknown }).response;
    if (typeof response === "string") return response;
    if (response && typeof response === "object") return JSON.stringify(response);
  }
  return "";
}

async function callVision(env: Env, dataUri: string, extraInstruction?: string): Promise<string> {
  const systemContent = extraInstruction ? `${SUGGEST_SYSTEM_PROMPT}\n\n${extraInstruction}` : SUGGEST_SYSTEM_PROMPT;
  const result = await env.AI.run(MODELS.imageVision, {
    messages: [
      { role: "system", content: systemContent },
      {
        role: "user",
        // A text part is required alongside the image; an image-only turn
        // produced empty responses on preview (see moderation/prompts.ts).
        content: [
          { type: "text", text: SUGGEST_USER_PROMPT },
          { type: "image_url", image_url: { url: dataUri } },
        ],
      },
    ],
    temperature: 0,
    max_tokens: MAX_TOKENS,
  });
  return extractResponseText(result);
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

export interface SuggestPhotoInput {
  r2_key_thumb: string;
  content_type: string;
}

/**
 * Reads `photo`'s R2 thumb, asks the vision model for a suggestion, and
 * validates the reply against `PhotoSuggestionSchema` — which constrains
 * `category` to the real enum and `title` to the real length bounds, so a
 * bad or hallucinated reply can never reach the client as something the
 * give-flow form can't submit. Never throws: every failure mode (missing
 * thumb, AI error, timeout, two malformed replies in a row) returns
 * `{ suggestion: null, reason }` instead of propagating.
 */
export async function suggestFromPhoto(env: Env, photo: SuggestPhotoInput): Promise<SuggestResult> {
  if (isMockAi(env)) return { suggestion: MOCK_SUGGESTION };

  const object = await env.BUCKET.get(photo.r2_key_thumb);
  if (!object) return { suggestion: null, reason: "thumb_missing" };

  const base64 = arrayBufferToBase64(await object.arrayBuffer());
  const contentType = object.httpMetadata?.contentType ?? photo.content_type ?? "image/jpeg";
  const dataUri = `data:${contentType};base64,${base64}`;

  try {
    const first = await withTimeout(callVision(env, dataUri), TIMEOUT_MS, "suggestVision");
    const parsed = tryParseSuggestion(first);
    if (parsed) return { suggestion: parsed };

    const retry = await withTimeout(callVision(env, dataUri, SUGGEST_RETRY_INSTRUCTION), TIMEOUT_MS, "suggestVision retry");
    const retryParsed = tryParseSuggestion(retry);
    if (retryParsed) return { suggestion: retryParsed };
    return { suggestion: null, reason: `unparseable: ${retry.slice(0, 160)}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("suggestFromPhoto: AI call failed", { error: message });
    return { suggestion: null, reason: message.slice(0, 200) };
  }
}

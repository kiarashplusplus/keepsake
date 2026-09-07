/**
 * Image moderation: one Workers AI vision call per stored photo **variant**.
 * Strict JSON in, `ImageVerdictSchema` out; one retry on a parse failure
 * before giving up to `"error"` (fail-closed — the listing stays `pending`
 * for the cron to retry, never auto-approved on a parse failure).
 *
 * This used to run from the `r2_key_thumb` object only, on the reasoning
 * that a 640px thumbnail is cheaper and carries plenty of signal. That
 * reasoning holds for a thumbnail *derived from* the full image, and the
 * thumbnail is not derived from anything: `PUT /api/photos` takes `full`
 * and `thumb` as two independent client-supplied files and stores both
 * verbatim, and `GET /i/:id/full` publishes the one no model had looked at
 * (#161). Both variants are served to the public, so both are moderated.
 * `MODERATED_PHOTO_VARIANTS` is the list, and it is what the `mod_image`
 * budget is charged per photo.
 */
import { ImageVerdictSchema, type ImageVerdict } from "@keepsake/contracts/admin";
import type { Env } from "../env.js";
import { isMockAi } from "../env.js";
import { MODELS } from "../models.js";
import { withTimeout } from "../lib/withTimeout.js";
import { IMAGE_RETRY_INSTRUCTION, IMAGE_SYSTEM_PROMPT, IMAGE_USER_PROMPT } from "./prompts.js";

const TIMEOUT_MS = 30_000;
const MAX_TOKENS = 200;

const MOCK_PASS_VERDICT: ImageVerdict = {
  is_physical_object: true,
  nsfw: 0,
  violence: 0,
  weapons: 0,
  drugs: 0,
  hate_symbols: 0,
  personal_info: 0,
  notes: "",
};

function stripCodeFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
}

function tryParseVerdict(text: string): ImageVerdict | null {
  try {
    const parsed: unknown = JSON.parse(stripCodeFences(text));
    const result = ImageVerdictSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Workers AI returns `response` as a string normally, but when the model
 * emits a JSON object it hands back the *parsed object* (observed on
 * preview 2026-09-05: `{"response":{"desc":"..."}}`). Normalise both to text
 * so the parser downstream sees one shape.
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
  const systemContent = extraInstruction ? `${IMAGE_SYSTEM_PROMPT}\n\n${extraInstruction}` : IMAGE_SYSTEM_PROMPT;
  const result = await env.AI.run(MODELS.imageVision, {
    messages: [
      { role: "system", content: systemContent },
      {
        role: "user",
        // A text part is required alongside the image; an image-only turn
        // produced empty responses on preview.
        content: [
          { type: "text", text: IMAGE_USER_PROMPT },
          { type: "image_url", image_url: { url: dataUri } },
        ],
      },
    ],
    temperature: 0,
    max_tokens: MAX_TOKENS,
  });
  return extractResponseText(result);
}

/**
 * Error outcome. Carries the message so the pipeline can store it in
 * `moderation_events.reason` — a bare "error" row taught us nothing when the
 * first real vision call failed on preview.
 */
export type ImageModerationError = { readonly error: string };

/**
 * Every stored variant of a photo that is reachable through
 * `GET /i/:id/:variant`, and therefore every variant a model has to look at
 * before the listing can be published. Ordered `thumb` first only so the
 * cheaper call happens first; both always run.
 *
 * Adding a variant here doubles nothing by itself — it multiplies the
 * `mod_image` cost per photo, which `moderation/pipeline.ts` charges as
 * `photos.length * MODERATED_PHOTO_VARIANTS.length`. Read that call site
 * before growing this list.
 */
export const MODERATED_PHOTO_VARIANTS = ["thumb", "full"] as const;
export type ModeratedPhotoVariant = (typeof MODERATED_PHOTO_VARIANTS)[number];

export function isImageError(v: ImageVerdict | ImageModerationError): v is ImageModerationError {
  return "error" in v;
}

/**
 * `imageBase64` is a bare base64 string (no data-URI prefix) — the caller
 * reads it straight off the R2 object for whichever variant it is
 * moderating. This function builds the `data:image/jpeg;base64,...` URI the
 * model input expects.
 */
export async function moderateImage(
  env: Env,
  imageBase64: string,
  contentType = "image/jpeg",
): Promise<ImageVerdict | ImageModerationError> {
  if (isMockAi(env)) return MOCK_PASS_VERDICT;

  const dataUri = `data:${contentType};base64,${imageBase64}`;

  try {
    const first = await withTimeout(callVision(env, dataUri), TIMEOUT_MS, "imageVision");
    const parsed = tryParseVerdict(first);
    if (parsed) return parsed;

    const retry = await withTimeout(callVision(env, dataUri, IMAGE_RETRY_INSTRUCTION), TIMEOUT_MS, "imageVision retry");
    const retryParsed = tryParseVerdict(retry);
    if (retryParsed) return retryParsed;
    return { error: `unparseable: ${retry.slice(0, 160)}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("moderateImage: AI call failed", { error: message });
    return { error: message.slice(0, 200) };
  }
}

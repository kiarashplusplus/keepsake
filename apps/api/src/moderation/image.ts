/**
 * Image moderation: one Workers AI vision call per photo, run from the R2
 * **thumb** (640px — cheaper, plenty of signal), never the full image. Strict
 * JSON in, `ImageVerdictSchema` out; one retry on a parse failure before
 * giving up to `"error"` (fail-closed — the listing stays `pending` for the
 * cron to retry, never auto-approved on a parse failure).
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
 * `thumbBase64` is a bare base64 string (no data-URI prefix) — the caller
 * reads it straight off the R2 object. This function builds the
 * `data:image/jpeg;base64,...` URI the model input expects.
 */
/**
 * Error outcome. Carries the message so the pipeline can store it in
 * `moderation_events.reason` — a bare "error" row taught us nothing when the
 * first real vision call failed on preview.
 */
export type ImageModerationError = { readonly error: string };

export function isImageError(v: ImageVerdict | ImageModerationError): v is ImageModerationError {
  return "error" in v;
}

export async function moderateImage(
  env: Env,
  thumbBase64: string,
  contentType = "image/jpeg",
): Promise<ImageVerdict | ImageModerationError> {
  if (isMockAi(env)) return MOCK_PASS_VERDICT;

  const dataUri = `data:${contentType};base64,${thumbBase64}`;

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

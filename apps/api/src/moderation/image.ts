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
import { IMAGE_RETRY_INSTRUCTION, IMAGE_SYSTEM_PROMPT } from "./prompts.js";

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

function extractResponseText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "response" in result) {
    const response = (result as { response: unknown }).response;
    if (typeof response === "string") return response;
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
        content: [{ type: "image_url", image_url: { url: dataUri } }],
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
export async function moderateImage(env: Env, thumbBase64: string): Promise<ImageVerdict | "error"> {
  if (isMockAi(env)) return MOCK_PASS_VERDICT;

  const dataUri = `data:image/jpeg;base64,${thumbBase64}`;

  try {
    const first = await withTimeout(callVision(env, dataUri), TIMEOUT_MS, "imageVision");
    const parsed = tryParseVerdict(first);
    if (parsed) return parsed;

    const retry = await withTimeout(callVision(env, dataUri, IMAGE_RETRY_INSTRUCTION), TIMEOUT_MS, "imageVision retry");
    const retryParsed = tryParseVerdict(retry);
    return retryParsed ?? "error";
  } catch (err) {
    console.error("moderateImage: AI call failed", { error: err instanceof Error ? err.message : String(err) });
    return "error";
  }
}

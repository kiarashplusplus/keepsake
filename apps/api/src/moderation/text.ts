/**
 * Text moderation: Llama Guard 3 (`MODELS.textGuard`) on `title\n\nstory`,
 * before a listing is ever public. Workers AI's typed output for this model
 * (`Ai_Cf_Meta_Llama_Guard_3_8B_Output`) is `response?: string | { safe,
 * categories }` — some deployments return the structured object, others the
 * classic Llama Guard text convention (`"safe"` or `"unsafe\nS1,S2"`). This
 * file accepts either; `decide.ts` only ever sees the parsed `TextVerdict`.
 */
import type { TextVerdict } from "@keepsake/contracts/admin";
import type { Env } from "../env.js";
import { isMockAi } from "../env.js";
import { MODELS } from "../models.js";
import { withTimeout } from "../lib/withTimeout.js";

const TIMEOUT_MS = 20_000;

/** `MOCK_AI="1"` (local dev, Playwright) always returns `safe` without
 * calling `env.AI` — see plan "Moderation pipeline". */
const MOCK_SAFE_VERDICT: TextVerdict = { verdict: "safe" };

interface StructuredGuardResponse {
  safe?: boolean;
  categories?: string[];
}

function normalizeCodes(codes: string[]): string[] {
  return codes.map((code) => code.trim().toUpperCase()).filter((code) => code.length > 0);
}

/** Parses the classic Llama Guard text convention: `"safe"`, or `"unsafe"`
 * followed by one or more `S<n>` codes on the next line. Exported for direct
 * unit testing of the parsing rule independent of the AI call itself. */
export function parseTextVerdict(raw: string): TextVerdict | "error" {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "error";

  if (/^safe$/i.test(trimmed)) return { verdict: "safe" };

  const match = /unsafe[\s\S]*?((?:s\d+[\s,]*)+)/i.exec(trimmed);
  if (match?.[1]) {
    const codes = normalizeCodes(match[1].split(/[,\s]+/));
    if (codes.length > 0) return { verdict: "unsafe", codes };
  }

  if (/^unsafe/i.test(trimmed)) return { verdict: "unsafe", codes: [] };

  return "error";
}

function toTextVerdict(result: unknown): TextVerdict | "error" {
  const response =
    result && typeof result === "object" && "response" in result
      ? (result as { response: unknown }).response
      : result;

  if (typeof response === "string") return parseTextVerdict(response);

  if (response && typeof response === "object") {
    const structured = response as StructuredGuardResponse;
    if (typeof structured.safe === "boolean") {
      return structured.safe
        ? { verdict: "safe" }
        : { verdict: "unsafe", codes: normalizeCodes(structured.categories ?? []) };
    }
  }

  return "error";
}

export async function moderateText(env: Env, title: string, story: string): Promise<TextVerdict | "error"> {
  if (isMockAi(env)) return MOCK_SAFE_VERDICT;

  const input = `${title}\n\n${story}`;

  try {
    const result = await withTimeout(
      env.AI.run(MODELS.textGuard, { messages: [{ role: "user", content: input }] }),
      TIMEOUT_MS,
      "textGuard",
    );
    return toTextVerdict(result);
  } catch (err) {
    console.error("moderateText: AI call failed", { error: err instanceof Error ? err.message : String(err) });
    return "error";
  }
}

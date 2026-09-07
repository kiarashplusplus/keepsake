/**
 * Semantic search embeddings (issue #38): one `env.AI` text-embedding call
 * per listing (on create/edit, `search/reembed.ts`) and one per search query
 * (`routes/feed.ts`), both landing in the same 768-dim Vectorize index
 * (`search/vectorize.ts`). `db/fts.ts`'s FTS5 search remains the fallback
 * path — see `routes/feed.ts` for exactly when it fires.
 *
 * No prompt is written here — an embedding call has no instructions to
 * follow, only text to encode — so the filled-in-example failure mode this
 * project has already shipped once (docs/design/moderation.md) doesn't
 * apply to this file. What still matters is not silently returning a vector
 * that means nothing: every failure path below returns `null`, never a
 * best-effort guess.
 */
import { isMockAi } from "../env.js";
import type { Env } from "../env.js";
import { MODELS } from "../models.js";
import { withTimeout } from "../lib/withTimeout.js";

const TIMEOUT_MS = 10_000;

export interface EmbeddableAspect {
  name: string;
  value: string;
}

/**
 * Builds the single string embedded for a listing, and reused verbatim to
 * embed a search query against the same space (`MODELS.embedding` is a
 * symmetric embedding model — no separate query/passage prefix convention
 * to apply).
 *
 * Title + story + aspects, not story + aspects alone, even though the
 * issue's own title says "story + aspects": a title like "Grandmother's
 * copper teapot" is real semantic signal a query like "family heirloom
 * kettle" should be able to match, and every other content field
 * (category, place) is already structured and filterable without needing
 * an embedding to stand in for it.
 */
export function embeddingText(title: string, story: string, aspects: EmbeddableAspect[]): string {
  const aspectLines = aspects.map((aspect) => `${aspect.name}: ${aspect.value}`);
  return [title, story, ...aspectLines].join("\n");
}

function extractVector(output: unknown): number[] | null {
  if (!output || typeof output !== "object") return null;
  const data = (output as { data?: unknown }).data;
  if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
  const vector = data[0] as unknown[];
  if (vector.length === 0 || !vector.every((value) => typeof value === "number")) return null;
  return vector as number[];
}

/**
 * Returns `null` on any failure — no binding, a thrown call, a timeout, or a
 * response shape that doesn't parse — never throws. Every caller (indexing
 * on write, embedding a query on read) treats `null` as "semantic search
 * isn't available right now, fall back."
 *
 * `isMockAi(env)` also short-circuits to `null`: unlike `moderateText`/
 * `moderateImage`'s canned "safe"/"pass" verdicts, there is no canned
 * embedding vector that would mean anything against a real Vectorize index
 * — local dev and Playwright rely on the FTS fallback firing instead, which
 * is itself exercised by MOCK_AI runs today.
 */
export async function embed(env: Env, text: string): Promise<number[] | null> {
  if (isMockAi(env)) return null;
  if (text.trim().length === 0) return null;

  try {
    const result = await withTimeout(env.AI.run(MODELS.embedding, { text }), TIMEOUT_MS, "embedding");
    return extractVector(result);
  } catch (err) {
    console.error("embed: AI call failed", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

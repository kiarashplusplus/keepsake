/**
 * The only file in this Worker allowed to name a Workers AI model id.
 *
 * Keeping every `@cf/…` string in one place means swapping a model — the
 * plan's fallback from the vision model to `llama-4-scout` if JSON parsing
 * misbehaves in practice (see plan Risks #4) — is a one-line change here, not
 * a grep-and-replace across the moderation pipeline. `tools/preflight`
 * enforces this by asserting `@cf/` strings appear nowhere else.
 */
export const MODELS = {
  /** Text moderation: title + story, before a listing is ever public. */
  textGuard: "@cf/meta/llama-guard-3-8b",
  /** Image moderation: one call per photo thumbnail. */
  imageVision: "@cf/meta/llama-3.2-11b-vision-instruct",
  /** Semantic search (issue #38): one embedding per listing (title + story +
   * aspects, `search/embedding.ts`) and one per search query, both landing
   * in the same 768-dim Vectorize index (`wrangler.toml`'s `[[vectorize]]`
   * binding, dimensions = 768 to match). Symmetric model — no separate
   * query/passage variant to pick between. */
  embedding: "@cf/baai/bge-base-en-v1.5",
} as const;

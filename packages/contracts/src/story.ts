/**
 * How a listing's story is shortened for display.
 *
 * There is no `story_excerpt` field on `PublicListing` — only the full
 * `story` — so every surface that shows less than all of it derives the short
 * form itself. That used to mean three different rules: the feed card's
 * (first sentence, else a word-boundary cut), the OG description's
 * (`story.slice(0, 200)`, which cuts mid-word), and the share card's. This
 * file is the one rule, so a keepsake's story reads the same in the feed, in
 * a link preview, and on the share card someone sends to a friend.
 *
 * It lives in `@keepsake/contracts` rather than `apps/web` because the Worker
 * needs it too (`apps/api/src/og/card.ts` and `routes/item.ts`) and cannot
 * import from the web app — the same reason the deterministic table-tilt moved
 * to `@keepsake/tokens/tilt`. It sits next to `CATEGORY_LABELS`, which is the
 * existing precedent for a presentation rule living in this package.
 */
const DEFAULT_MAX_LENGTH = 140;

function firstSentence(story: string): string | null {
  const match = /^[^.!?\n]+[.!?]/.exec(story.trim());
  return match ? match[0].trim() : null;
}

/**
 * The first sentence when it fits, otherwise a clean word-boundary cut with
 * an ellipsis. Never breaks mid-word unless the first word alone is longer
 * than `maxLength`.
 *
 * Callers that render into a fixed box (the share card) should collapse
 * whitespace first — `\n` deliberately terminates a "sentence" here, which is
 * right for a paragraph and wrong for a line-wrapped one.
 */
export function storyExcerpt(story: string, maxLength: number = DEFAULT_MAX_LENGTH): string {
  const trimmed = story.trim();
  const sentence = firstSentence(trimmed);
  if (sentence !== null && sentence.length <= maxLength) return sentence;

  const source = sentence ?? trimmed;
  if (source.length <= maxLength) return source;

  const cut = source.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  const boundary = lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${boundary.trimEnd()}…`;
}

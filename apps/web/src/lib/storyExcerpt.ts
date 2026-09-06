/**
 * The one line of story italic on every tag card. There is no separate
 * `storyExcerpt` field in `@keepsake/contracts/listing`'s `PublicListing` —
 * only the full `story` — so this derives a card-length line from it
 * client-side: the first sentence if it's short enough, otherwise a clean
 * word-boundary truncation. Kept pure/exported so the feed card and the give
 * flow's review step (which does the same truncation inline today) can share
 * one rule.
 */
const DEFAULT_MAX_LENGTH = 140;

function firstSentence(story: string): string | null {
  const match = /^[^.!?\n]+[.!?]/.exec(story.trim());
  return match ? match[0].trim() : null;
}

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

/**
 * The single place that builds an FTS5 `MATCH` query string, per
 * docs/design/feed.md and plan Risk #2 ("D1 FTS5 external-content +
 * triggers" — `fts.ts` is the named fallback point to `LIKE` if D1's FTS5
 * setup misbehaves in practice). Nothing else in this codebase should touch
 * FTS5 query syntax directly — a swap to `LIKE '%term%'` chains only ever
 * has to change `sanitizeFtsQuery`'s caller in `src/routes/feed.ts`, not the
 * sanitization rules themselves.
 *
 * Rules: strip FTS5 syntax characters so raw user input never accidentally
 * writes a query operator, split into implicit-AND terms (bare
 * space-separated tokens are ANDed by FTS5 by default), and add a trailing
 * `*` prefix wildcard to the last token only — the token the user is either
 * still typing or just finished, so "grandmother" matches "grandmother's".
 * Earlier tokens stay exact to keep multi-word queries from over-matching.
 */
export function sanitizeFtsQuery(raw: string): string | null {
  const tokens = raw
    // FTS5 query syntax characters (column filters, phrase quotes, NEAR,
    // boolean operators via punctuation) — replaced with spaces rather than
    // dropped so "cat-toy" still splits into two tokens instead of "cattoy".
    .replace(/["*^:()~-]/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}\p{N}']/gu, ""))
    .filter((token) => token.length > 0);

  if (tokens.length === 0) return null;

  return tokens.map((token, index) => (index === tokens.length - 1 ? `${token}*` : token)).join(" ");
}

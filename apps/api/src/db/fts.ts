/**
 * The single place that builds an FTS5 `MATCH` query string, per
 * docs/design/feed.md and plan Risk #2 ("D1 FTS5 external-content +
 * triggers" — `fts.ts` is the named fallback point to `LIKE` if D1's FTS5
 * setup misbehaves in practice). Nothing else in this codebase should touch
 * FTS5 query syntax directly — a swap to `LIKE '%term%'` chains only ever
 * has to change `sanitizeFtsQuery`'s caller in `src/routes/feed.ts`, not the
 * sanitization rules themselves.
 *
 * Rules: split the raw input on **every** non-alphanumeric character, wrap
 * each resulting token as an FTS5 quoted string, and add a trailing `*`
 * prefix wildcard (outside the closing quote) to the last token only — the
 * token the user is either still typing or just finished. Earlier tokens
 * stay exact to keep multi-word queries from over-matching. Bare
 * space-separated terms are ANDed by FTS5 by default, so this is still the
 * "implicit AND" query the feed documents.
 *
 * ## Why the split is "every non-alphanumeric" and the tokens are quoted (#163)
 *
 * Both halves of this are load-bearing, and both were bugs before:
 *
 *  - The old rule kept `'` inside a token, deliberately, so that
 *    "grandmother" would match "grandmother's". `'` is **not** a bareword
 *    character in FTS5's query grammar (only non-ASCII, ASCII alphanumerics
 *    and `_` are), so `?q=grandmother's ring` handed `listings_fts MATCH` a
 *    string it could not parse and the feed answered **500** with the raw
 *    D1 driver message in the body. The apostrophe was kept to make
 *    possessives work; keeping it is what broke them.
 *
 *    Merely *dropping* `'` from the kept set — the fix the issue suggested —
 *    is not enough, and was measured against real SQLite (node:sqlite,
 *    FTS5, the schema from `migrations/0003_fts.sql`) rather than assumed:
 *    deleting the character glues the halves together, so
 *    `grandmother's ring` becomes the token `grandmothers`, which matches
 *    **nothing** — the indexed text has the tokens `grandmother` and `s`.
 *    Splitting on the apostrophe instead is what works, because it is
 *    exactly what `unicode61` already does to the *stored* text at index
 *    time. Query-side tokenization now matches index-side tokenization by
 *    construction, which is the property that makes possessives work at
 *    all. It also handles the typographic apostrophe an iOS keyboard
 *    produces (`grandmother’s`), which is not `'` and would otherwise be
 *    deleted rather than split on.
 *
 *  - Unquoted tokens reach the grammar as **operators**. `"a" OR b`
 *    sanitized to `a OR b*`, which FTS5 reads as its boolean OR, not as the
 *    implicit-AND terms this module documents — so a crafted query changed
 *    which rows came back. `AND`, `NOT` and `NEAR` are the same. Wrapping
 *    every token in double quotes makes it a literal string in the grammar;
 *    the tokens themselves are alphanumeric-only by then, so there is never
 *    an internal `"` to escape.
 *
 * `routes/feed.ts` still wraps every `MATCH` in a `try`/`catch` so that a
 * future slip here degrades to an empty result set rather than a 500 that
 * leaks the driver message. This function should never produce an
 * unparseable query — that is the belt; the catch is the braces.
 */
export function sanitizeFtsQuery(raw: string): string | null {
  // One rule, applied to everything: any run of characters that is not a
  // letter or a digit separates tokens. That is what `unicode61` does to the
  // indexed text (`migrations/0003_fts.sql`), so "cat-toy" still splits into
  // two tokens, `(paren)`/`^caret`/`col:on` lose their syntax characters,
  // and a possessive splits the same way on both sides of the index.
  const tokens = raw.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0);

  if (tokens.length === 0) return null;

  return tokens.map((token, index) => (index === tokens.length - 1 ? `"${token}"*` : `"${token}"`)).join(" ");
}

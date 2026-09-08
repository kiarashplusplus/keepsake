/**
 * Serialising JSON-LD into a `<script type="application/ld+json">` block.
 *
 * ## This is NOT HTML escaping, and must never become it
 *
 * The obvious "tidy-up" is to route this through `escapeHtml` like every
 * other injected string in `routes/item.ts`. That corrupts the data. Inside a
 * `<script>` element the content is **raw text**, not parsed markup: an `&`
 * turned into `&amp;` is not decoded back by the HTML parser, so a listing
 * titled "Salt & pepper pots" arrives at Google as the literal string
 * "Salt &amp;amp; pepper pots". The JSON stays syntactically valid, the page
 * looks fine, and the structured data is quietly wrong.
 *
 * What actually has to be escaped is narrower: the sequences that could end
 * the script block or be mistaken for the start of one. `JSON.stringify`
 * already handles quotes, backslashes and control characters; this adds:
 *
 *   `<` and `>`   ->  \u003c and \u003e, so `</script>` cannot appear
 *                     literally in the block, and neither can `<!--`
 *   `&`           ->  \u0026, defence in depth for parsers that decode
 *                     entities in contexts where they should not
 *   U+2028, U+2029 -> \u2028 and \u2029, the line and paragraph
 *                     separators, which are literal line terminators to
 *                     some older JS parsers and can break the block
 *
 * All four are valid JSON string escapes, so `JSON.parse` yields exactly the
 * original value — asserted in `test/item.test.ts` with a title containing a
 * literal `</script>`.
 */

/** Values safe to hand to `JSON.stringify` for an ld+json block. */
export type JsonLdValue = string | number | boolean | null | JsonLdValue[] | { [key: string]: JsonLdValue | undefined };

export function serializeJsonLd(value: JsonLdValue): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** The full `<script>` element, ready to append to `<head>`. */
export function jsonLdScript(value: JsonLdValue): string {
  return `<script type="application/ld+json">${serializeJsonLd(value)}</script>`;
}

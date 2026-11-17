/**
 * Pure functions: Wikipedia plain text in, verbatim gifting passages out.
 *
 * Nothing here touches the network, so every rule about what counts as a
 * passage — and, as importantly, what does not — is unit-testable against a
 * fixed string (`test/extract.test.mjs`).
 *
 * Input is the TextExtracts plain-text rendering (`explaintext=1`,
 * `exsectionformat=wiki`): headings as `== Heading ==` lines, one paragraph
 * per line. Footnote markers and templates are already stripped by
 * MediaWiki, which also means "[citation needed]" is invisible here — see
 * README.md "Known gaps".
 */
import { createHash } from "node:crypto";
import { EXCLUDED_RE, GIFT_RE, OCCASION_RES, PRACTICE_RES, SKIPPED_SECTIONS } from "./lexicon.mjs";

/** Paragraphs shorter than this are captions, table cells or list stubs. */
export const MIN_PARAGRAPH_CHARS = 40;

const HEADING = /^(={2,6})\s*(.+?)\s*\1\s*$/;

/**
 * Split a TextExtracts body into paragraphs, each carrying the path of
 * headings above it (`[]` for the lead).
 */
export function parseSections(text) {
  const paragraphs = [];
  const path = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const heading = line.match(HEADING);
    if (heading) {
      const depth = heading[1].length - 2; // "==" is depth 0
      path.length = depth;
      path[depth] = heading[2];
      continue;
    }
    paragraphs.push({ headingPath: path.filter(Boolean), text: line });
  }
  return paragraphs;
}

export function isSkippedSection(headingPath) {
  return headingPath.some((h) => SKIPPED_SECTIONS.includes(h.toLowerCase()));
}

const ABBREVIATIONS = new Set([
  "st",
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "jr",
  "vs",
  "etc",
  "e.g",
  "i.e",
  "approx",
  "ca",
  "c",
  "no",
  "u.s",
  "u.k",
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
]);

/**
 * Sentence split that survives "St. Nicholas", "U.S. Christmas" and "c. 1900".
 * Splits only on . ! ? followed by whitespace and an upper-case letter,
 * digit or opening quote, and never after a known abbreviation.
 */
export function splitSentences(paragraph) {
  const sentences = [];
  let start = 0;
  const boundary = /([.!?])["'”’)]*\s+(?=[\p{Lu}\p{N}"“'‘(])/gu;
  let m;
  while ((m = boundary.exec(paragraph))) {
    if (m[1] === ".") {
      const before = paragraph.slice(start, m.index);
      const word = before.match(/([\p{L}.]+)$/u)?.[1]?.toLowerCase() ?? "";
      if (ABBREVIATIONS.has(word) || /^\p{Lu}$/u.test(word)) continue; // "J. Smith"
    }
    const end = m.index + m[0].length;
    sentences.push(paragraph.slice(start, end).trim());
    start = end;
  }
  const tail = paragraph.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences;
}

function spans(re, text) {
  re.lastIndex = 0;
  return [...text.matchAll(re)].map((m) => ({
    term: m[0],
    start: m.index,
    end: m.index + m[0].length,
  }));
}

/**
 * Gift-vocabulary hits in `text`, minus those inside an excluded phrase
 * ("gift shop", "souvenir stand"). Returns the matched terms, lower-cased,
 * in order of appearance.
 */
export function giftTerms(text) {
  const excluded = spans(EXCLUDED_RE, text);
  return spans(GIFT_RE, text)
    .filter((hit) => !excluded.some((ex) => hit.start >= ex.start && hit.end <= ex.end))
    .map((hit) => hit.term.toLowerCase());
}

function tagWith(table, text) {
  const evidence = {};
  for (const [tag, re] of Object.entries(table)) {
    const hits = spans(re, text).map((h) => h.term.toLowerCase());
    if (hits.length) evidence[tag] = [...new Set(hits)];
  }
  return evidence;
}

/** Occasion and practice labels for a passage, with the words that earned each. */
export function tagPassage(text) {
  return { occasions: tagWith(OCCASION_RES, text), practices: tagWith(PRACTICE_RES, text) };
}

/**
 * A passage is "weak" when nothing about it speaks to a custom: its only
 * practice labels are civic/diplomatic ("a gift from France") or commercial,
 * and it names no occasion. Weak passages are kept — the data stays complete
 * — but they do not count towards a location's coverage level.
 */
export function isWeak(tags) {
  const practices = Object.keys(tags.practices);
  if (Object.keys(tags.occasions).length) return false;
  return practices.every((p) => p === "civic-or-diplomatic" || p === "commercial");
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Case-sensitive whole-word matcher for a subject's names. Case-sensitive
 * because place names collide with ordinary words ("Nice", "Reading",
 * "Split", "Mobile") and a capital letter is the only cheap signal that
 * the place is meant.
 */
export function mentionMatcher(names) {
  const unique = [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 3))];
  if (!unique.length) return () => [];
  unique.sort((a, b) => b.length - a.length);
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${unique.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}])`,
    "gu",
  );
  return (text) => [...new Set([...text.matchAll(re)].map((m) => m[0]))];
}

export function passageId(title, text) {
  return createHash("sha256").update(`${title}\n${text}`).digest("hex").slice(0, 16);
}

/**
 * Pull gifting passages out of one article for one subject.
 *
 * `requiresMention` is the line between an article that is *about* the
 * subject (its own article, "Etiquette in Japan") and one that merely
 * turned up in a search ("Red envelope", which covers five countries).
 * For the latter a paragraph must name the subject — or sit under a heading
 * that does — or it is not evidence about this place. The article's lead
 * mentioning the subject is deliberately not enough: that is how a
 * Vietnamese lì xì paragraph would end up filed under China.
 */
export function extractPassages({ title, text, subjectNames, requiresMention }) {
  const titleTerms = giftTerms(title);
  const titleIsAboutGifts = titleTerms.length > 0;
  const mentions = mentionMatcher(subjectNames);
  const out = [];
  const seen = new Set();
  for (const { headingPath, text: paragraph } of parseSections(text)) {
    if (paragraph.length < MIN_PARAGRAPH_CHARS || isSkippedSection(headingPath)) continue;

    const paragraphTerms = giftTerms(paragraph);
    const headingTerms = giftTerms(headingPath.join(" • "));
    let matchedBy;
    if (paragraphTerms.length) matchedBy = "paragraph";
    else if (headingTerms.length) matchedBy = "heading";
    else if (titleIsAboutGifts) matchedBy = "article-title";
    else continue;

    const named = [...mentions(paragraph), ...mentions(headingPath.join(" • "))];
    if (requiresMention && !named.length) continue;

    const id = passageId(title, paragraph);
    if (seen.has(id)) continue;
    seen.add(id);

    const sentences = splitSentences(paragraph);
    const giftSentences =
      matchedBy === "paragraph" ? sentences.filter((s) => giftTerms(s).length) : sentences;
    const tags = tagPassage(paragraph);
    out.push({
      id,
      headingPath,
      text: paragraph,
      giftSentences,
      matchedBy,
      giftTerms: [
        ...new Set(
          { paragraph: paragraphTerms, heading: headingTerms, "article-title": titleTerms }[
            matchedBy
          ],
        ),
      ],
      subjectMentions: [...new Set(named)],
      tags,
      weak: isWeak(tags),
    });
  }
  return out;
}

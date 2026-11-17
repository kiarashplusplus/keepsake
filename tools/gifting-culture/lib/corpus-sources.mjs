/**
 * Collect a subject's passages from the gifting corpus (the dump path), in
 * the same shape `collectSubject` produces from the API.
 *
 * Discovery, strongest first, recorded on every passage as `discoveredBy`:
 *
 *   place-article     the place's own article
 *   culture-article   Wikidata's P2596 article for the place
 *   about-title       an article whose *title* says it is about the place:
 *                     "Christmas in Japan", "Etiquette in Japan",
 *                     "Japanese wedding customs"
 *   corpus-mention    any other article, for paragraphs that name the place in
 *                     the same sentence as the gift vocabulary
 *
 * The last is what the API path could only approximate with search: every
 * article in Wikipedia is read, so "In Kraków, children receive gifts on
 * St. Nicholas Day" is found in whatever article it sits in.
 *
 * **Ambiguous names.** A name that belongs to more than one place in the run
 * ("Valencia", "Hyderabad", "San José") only counts for a place whose
 * country or region the same article also names. Otherwise the mention is
 * dropped for all of them: a passage filed under the wrong Valencia is worse
 * than a passage missing from both.
 */
import { extractPassages, giftTerms, relevance, splitSentences } from "./extract.mjs";
import { shortName, subjectNames } from "./sources.mjs";

const ABOUT_PREFIX =
  "Culture|Etiquette|Cuisine|Customs|Traditions|Public holidays|Holidays|Festivals|Christmas|New Year|Weddings?|Wedding customs|Marriage|Funerals?|Gift[- ]giving|Hospitality|Religion";
const ABOUT_OF = new RegExp(`^(?:${ABOUT_PREFIX}) (?:in|of) (?:the )?(.+)$`);
const ABOUT_DEMONYM =
  /^(.+?) (?:wedding customs|weddings?|marriage|funerals?|etiquette|customs|culture|holidays|festivals|cuisine|gift[- ]giving|hospitality)$/i;

const MAX_NGRAM = 5;

/** Capitalised word sequences (1–5 words) in `text`: the only way a place name appears. */
function capitalisedNgrams(text) {
  const tokens = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) ?? [];
  const out = new Set();
  for (let i = 0; i < tokens.length; i++) {
    if (!/^\p{Lu}/u.test(tokens[i])) continue;
    let phrase = "";
    for (let n = 0; n < MAX_NGRAM && i + n < tokens.length; n++) {
      phrase = n ? `${phrase} ${tokens[i + n]}` : tokens[i];
      out.add(phrase.replace(/[.'’-]+$/, ""));
    }
  }
  return out;
}

/**
 * One pass over the corpus for every subject in the run.
 *
 * @param byTitle  from `loadCorpus`
 * @param subjects every node (cities, regions, countries) in locations.json
 * @param contextNames qid → names of that subject's region(s) and country(ies)
 */
export function indexCorpus(byTitle, subjects, contextNames = new Map()) {
  /** name → Set(qid) */
  const nameOwners = new Map();
  for (const s of subjects) {
    if (!s.title) continue;
    for (const name of subjectNames(s)) {
      if (name.length < 3) continue;
      if (!nameOwners.has(name)) nameOwners.set(name, new Set());
      nameOwners.get(name).add(s.qid);
    }
  }

  /** qid → Set(title) for about-title and corpus-mention discovery */
  const aboutTitles = new Map();
  const mentionTitles = new Map();
  const add = (map, qid, title) => {
    if (!map.has(qid)) map.set(qid, new Set());
    map.get(qid).add(title);
  };

  for (const [title, article] of byTitle) {
    const about = title.match(ABOUT_OF)?.[1] ?? title.match(ABOUT_DEMONYM)?.[1];
    if (about) for (const qid of nameOwners.get(about) ?? []) add(aboutTitles, qid, title);

    const allText = `${title}\n${article.paragraphs.map((p) => p.text).join("\n")}`;
    for (const p of article.paragraphs) {
      const why = relevance(title, p.headingPath, p.text);
      if (!why) continue;
      const scopes = [];
      if (why.matchedBy === "paragraph")
        scopes.push(...splitSentences(p.text).filter((s) => giftTerms(s).length));
      if (why.matchedBy === "heading") scopes.push(p.headingPath.join(" "));
      for (const scope of scopes) {
        for (const gram of capitalisedNgrams(scope)) {
          const owners = nameOwners.get(gram);
          if (!owners) continue;
          if (owners.size === 1) {
            add(mentionTitles, [...owners][0], title);
            continue;
          }
          // Ambiguous: keep only owners whose region or country this article names.
          for (const qid of owners) {
            const context = contextNames.get(qid) ?? [];
            if (context.some((c) => allText.includes(c))) add(mentionTitles, qid, title);
          }
        }
      }
    }
  }
  return { aboutTitles, mentionTitles, nameOwners };
}

/** Same return shape as `collectSubject`. */
export function collectFromCorpus({ byTitle, index, subject, log = () => {} }) {
  const candidates = new Map(); // title → { discoveredBy, requiresMention }
  const add = (title, discoveredBy, requiresMention) => {
    if (title && byTitle.has(title) && !candidates.has(title))
      candidates.set(title, { discoveredBy, requiresMention });
  };
  add(subject.title, "place-article", false);
  for (const t of subject.cultureTitles ?? []) add(t, "culture-article", false);
  for (const t of index.aboutTitles.get(subject.qid) ?? []) add(t, "about-title", false);
  for (const t of index.mentionTitles.get(subject.qid) ?? []) add(t, "corpus-mention", true);

  const names = subjectNames(subject);
  const sources = [];
  const passages = [];
  for (const [title, how] of candidates) {
    const article = byTitle.get(title);
    const found = extractPassages({
      title,
      paragraphs: article.paragraphs,
      subjectNames: names,
      requiresMention: how.requiresMention,
      mentionScope: how.requiresMention ? "sentence" : "paragraph",
      renderer: "dump-wikitext",
    });
    if (!found.length) continue;
    const source = {
      title,
      pageId: article.pageId,
      revisionId: article.revisionId,
      revisionTimestamp: article.revisionTimestamp,
      discoveredBy: how.discoveredBy,
    };
    sources.push({ ...source, passages: found.length });
    for (const p of found) passages.push({ ...p, source });
  }
  log(
    `    ${subject.kind} ${shortName(subject.title)}: ${candidates.size} articles, ${passages.length} passages`,
  );
  return { subject, sources, passages };
}

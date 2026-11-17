/**
 * For one subject (a city, a region or a country): which Wikipedia articles
 * might describe its gifting culture, and the passages they yield.
 *
 * Three ways an article becomes a candidate, recorded on every passage as
 * `discoveredBy` so a reviewer can weigh them differently:
 *
 *   place-article     the subject's own article ("Osaka")
 *   culture-article   Wikidata's "culture" property (P2596) or a probed
 *                     title such as "Etiquette in Japan" — about the
 *                     subject by construction
 *   search            Wikipedia full-text search ("Omiyage", "Red envelope")
 *                     — about *something*, so every paragraph must name the
 *                     subject itself (`requiresMention`)
 */
import { extractPassages } from "./extract.mjs";
import { fetchArticle, lookupPages, search } from "./wikipedia.mjs";

const COUNTRY_TEMPLATES = [
  "Culture of {}",
  "Etiquette in {}",
  "Etiquette of {}",
  "Gift-giving in {}",
  "Gift giving in {}",
  "Public holidays in {}",
  "Christmas in {}",
  "Festivals in {}",
  "Wedding customs in {}",
  "Weddings in {}",
];
const LOCAL_TEMPLATES = ["Culture of {}", "Festivals in {}", "Christmas in {}"];

/** "Georgia (country)" → "Georgia"; "Portland, Oregon" → "Portland". */
export function shortName(title) {
  return title
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/,.*$/, "")
    .trim();
}

/** Every string a passage could use to name the subject. */
export function subjectNames(subject) {
  const names = [subject.title, subject.label, ...(subject.demonyms ?? [])].filter(Boolean);
  if (subject.title) names.push(shortName(subject.title));
  return [...new Set(names)];
}

/** Titles worth probing for this subject, before redirects are resolved. */
export function templateTitles(subject) {
  const name = shortName(subject.title);
  const templates = subject.kind === "country" ? COUNTRY_TEMPLATES : LOCAL_TEMPLATES;
  const titles = [];
  for (const t of templates) {
    titles.push(t.replace("{}", name));
    // "Culture of the United States", "Public holidays in the Philippines".
    if (subject.kind === "country") titles.push(t.replace("{}", `the ${name}`));
  }
  return titles;
}

export function searchQueries(subject) {
  const name = shortName(subject.title);
  const queries = [`"${name}" gift-giving tradition`];
  const demonym = subject.demonyms?.[0];
  if (demonym && demonym !== name) queries.push(`"${demonym}" gifts custom`);
  return queries;
}

/**
 * Gather candidates, fetch each once, extract passages. `searchLimit` of 0
 * turns search off for this subject.
 */
export async function collectSubject(client, subject, { searchLimit = 8, log = () => {} } = {}) {
  /** Requested title → how it was found. First (strongest) discovery wins. */
  const requested = [];
  const add = (title, discoveredBy, requiresMention) => {
    if (title) requested.push({ title, discoveredBy, requiresMention });
  };
  add(subject.title, "place-article", false);
  for (const title of subject.cultureTitles ?? []) add(title, "culture-article", false);
  for (const title of templateTitles(subject)) add(title, "culture-article", false);
  if (searchLimit > 0) {
    for (const query of searchQueries(subject)) {
      for (const title of await search(client, query, searchLimit)) add(title, "search", true);
    }
  }

  // One request per 50 titles: existence, redirects, disambiguation and the
  // current revision of every candidate at once.
  const pages = await lookupPages(
    client,
    requested.map((r) => r.title),
  );
  /** pageId → { page, discoveredBy, requiresMention } */
  const candidates = new Map();
  for (const r of requested) {
    const page = pages.get(r.title);
    if (!page || candidates.has(page.pageId)) continue;
    // This subject's own article reached under another title (a "Culture of
    // Osaka" redirect into "Osaka") is not a second source.
    if (r.discoveredBy !== "place-article" && page.wikidataId && page.wikidataId === subject.qid)
      continue;
    candidates.set(page.pageId, {
      page,
      discoveredBy: r.discoveredBy,
      requiresMention: r.requiresMention,
    });
  }

  const names = subjectNames(subject);
  const sources = [];
  const passages = [];
  for (const { page, discoveredBy, requiresMention } of candidates.values()) {
    const article = await fetchArticle(client, page);
    if (!article) continue;
    const found = extractPassages({
      title: article.title,
      text: article.text,
      subjectNames: names,
      requiresMention,
    });
    const source = {
      title: article.title,
      pageId: article.pageId,
      revisionId: article.revisionId,
      revisionTimestamp: article.revisionTimestamp,
      discoveredBy,
    };
    sources.push({ ...source, passages: found.length });
    for (const p of found) passages.push({ ...p, source });
  }
  log(
    `    ${subject.kind} ${subject.title}: ${candidates.size} articles, ${passages.length} passages`,
  );
  return { subject, sources, passages };
}

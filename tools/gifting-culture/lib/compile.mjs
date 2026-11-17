/**
 * One city's neutral record: its passages from every scope above it, each
 * labelled with the scope it is evidence *for*.
 *
 * The scope label is the most important field in the output. Wikipedia says
 * a great deal about Japanese gift-giving and almost nothing about gift-
 * giving in Hamamatsu specifically; a story that says "in Hamamatsu, people
 * bring omiyage" from a country-scope passage is making a claim the source
 * does not make. `coverage.level` exists so the story layer can see that
 * before it writes a word.
 */
import { LICENSE, articleUrl, historyUrl, revisionUrl } from "./wikipedia.mjs";
import { shortName } from "./sources.mjs";

export const SCHEMA_VERSION = 1;
const SCOPES = ["city", "region", "country"];

export function slugify(name) {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function cityFileName(city) {
  const slug = slugify(shortName(city.title));
  return slug ? `${slug}--${city.qid}.json` : `${city.qid}.json`;
}

/**
 * The narrowest scope with at least one non-weak passage, or "none".
 * Weak passages ("a gift from France") are counted but never set the level.
 */
export function coverageLevel(passages) {
  for (const scope of SCOPES) if (passages.some((p) => p.scope === scope && !p.weak)) return scope;
  return "none";
}

const subjectRef = (s) => ({ qid: s.qid, name: shortName(s.title), wikipediaTitle: s.title });

/**
 * @param city        the city node from locations.json
 * @param collections `{ city, regions: [...], countries: [...] }`, each the
 *                    result of `collectSubject` for that node
 */
export function compileCity({ city, regions, countries, collections, generatedAt }) {
  const ordered = [
    ["city", [collections.city]],
    ["region", collections.regions],
    ["country", collections.countries],
  ];

  const passages = [];
  const seen = new Set();
  const sourceUse = new Map();
  for (const [scope, list] of ordered) {
    for (const collection of list) {
      for (const p of collection.passages) {
        // The same paragraph can surface at several scopes (a city search
        // landing in "Etiquette in Japan"); the narrowest scope keeps it.
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        const { source, ...rest } = p;
        passages.push({
          id: p.id,
          scope,
          subject: subjectRef(collection.subject),
          source: {
            title: source.title,
            url: articleUrl(source.title),
            revisionId: source.revisionId,
            revisionUrl: source.revisionId ? revisionUrl(source.revisionId) : null,
            revisionTimestamp: source.revisionTimestamp,
            discoveredBy: source.discoveredBy,
          },
          ...Object.fromEntries(Object.entries(rest).filter(([k]) => k !== "id")),
        });
        const key = `${source.title}@${source.revisionId}`;
        const entry = sourceUse.get(key) ?? {
          title: source.title,
          url: articleUrl(source.title),
          revisionId: source.revisionId,
          revisionUrl: source.revisionId ? revisionUrl(source.revisionId) : null,
          authorsUrl: historyUrl(source.title),
          license: LICENSE,
          passages: 0,
        };
        entry.passages++;
        sourceUse.set(key, entry);
      }
    }
  }

  const count = (pred) =>
    Object.fromEntries(
      SCOPES.map((s) => [s, passages.filter((p) => p.scope === s && pred(p)).length]),
    );

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    location: {
      qid: city.qid,
      name: shortName(city.title),
      wikipediaTitle: city.title,
      label: city.label,
      population: city.population,
      coordinates: city.coordinates,
      demonyms: city.demonyms,
      regions: regions.map(subjectRef),
      countries: countries.map((c) => ({ ...subjectRef(c), iso2: c.iso2 })),
    },
    coverage: {
      level: coverageLevel(passages),
      passages: count(() => true),
      strongPassages: count((p) => !p.weak),
    },
    passages,
    sources: [...sourceUse.values()],
    attribution:
      `Passages are verbatim excerpts of English Wikipedia articles at the revisions listed in \`sources\`, ` +
      `licensed ${LICENSE.name} (${LICENSE.url}). Authors are listed in each article's history (\`authorsUrl\`). ` +
      `Any published text that reuses or adapts these passages must credit Wikipedia and carry the same licence.`,
  };
}

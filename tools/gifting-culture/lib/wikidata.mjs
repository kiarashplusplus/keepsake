/**
 * Locations from Wikidata: which cities exist, what region and country each
 * sits in, and the names a passage might use for them.
 *
 * One SPARQL query per country, not one for the world. A single worldwide
 * "every city over N people" query with the `P31/P279*` class walk takes
 * ~30 s at N = 3,000,000 and times out (60 s limit) well before N gets
 * interesting; per country it is a few seconds each. A shard that still
 * fails is recorded in `failedShards` and fails the run — a city list that
 * silently lacks a country is the kind of check that cannot fail.
 */

export const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";

/** Q515 "city" and everything that subclasses it ("big city", "city of Japan", …). */
const CITY_CLASS = "wd:Q515";
/** Q10864048 "first-level administrative country subdivision". */
const ADMIN1_CLASS = "wd:Q10864048";

const qidOf = (uri) => uri.slice(uri.lastIndexOf("/") + 1);

export function countriesQuery() {
  return `SELECT ?country ?iso WHERE {
  ?country wdt:P297 ?iso .
  FILTER NOT EXISTS { ?country wdt:P576 ?dissolved }
}`;
}

export function citiesQuery({ iso2, minPopulation }) {
  if (!/^[A-Z]{2}$/.test(iso2)) throw new Error(`not an ISO 3166-1 alpha-2 code: ${iso2}`);
  return `SELECT ?city ?pop ?article ?coord ?admin1 ?country WHERE {
  ?country wdt:P297 "${iso2}" .
  ?city wdt:P17 ?country ; wdt:P1082 ?pop .
  FILTER(?pop >= ${Math.floor(minPopulation)})
  ?city wdt:P31/wdt:P279* ${CITY_CLASS} .
  ?article schema:about ?city ; schema:isPartOf <https://en.wikipedia.org/> .
  OPTIONAL { ?city wdt:P625 ?coord }
  OPTIONAL { ?city wdt:P131* ?admin1 . ?admin1 wdt:P31/wdt:P279* ${ADMIN1_CLASS} . }
}`;
}

export function citiesByQidQuery(qids) {
  const values = qids.map((q) => {
    if (!/^Q\d+$/.test(q)) throw new Error(`not a Wikidata item id: ${q}`);
    return `wd:${q}`;
  });
  return `SELECT ?city ?pop ?article ?coord ?admin1 ?country WHERE {
  VALUES ?city { ${values.join(" ")} }
  ?city wdt:P17 ?country .
  ?article schema:about ?city ; schema:isPartOf <https://en.wikipedia.org/> .
  OPTIONAL { ?city wdt:P1082 ?pop }
  OPTIONAL { ?city wdt:P625 ?coord }
  OPTIONAL { ?city wdt:P131* ?admin1 . ?admin1 wdt:P31/wdt:P279* ${ADMIN1_CLASS} . }
}`;
}

function parsePoint(wkt) {
  const m = wkt?.match(/^Point\(([-\d.eE]+) ([-\d.eE]+)\)$/);
  return m ? { lat: Number(m[2]), lng: Number(m[1]) } : null;
}

const titleFromArticleUrl = (url) =>
  decodeURIComponent(url.slice(url.lastIndexOf("/wiki/") + 6)).replace(/_/g, " ");

/**
 * Collapse SPARQL rows into one record per city. Rows multiply because a
 * city can have several population statements, coordinates, regions or —
 * for disputed places — countries; every distinct region and country is
 * kept rather than one being picked, since picking is a political claim.
 */
export function mergeCityRows(bindings) {
  const byQid = new Map();
  for (const row of bindings) {
    const qid = qidOf(row.city.value);
    const city = byQid.get(qid) ?? {
      qid,
      title: titleFromArticleUrl(row.article.value),
      population: null,
      coordinates: null,
      countries: [],
      regions: [],
    };
    const pop = row.pop ? Number(row.pop.value) : null;
    if (pop != null && Number.isFinite(pop) && (city.population == null || pop > city.population))
      city.population = pop;
    city.coordinates ??= parsePoint(row.coord?.value);
    const country = row.country ? qidOf(row.country.value) : null;
    if (country && !city.countries.includes(country)) city.countries.push(country);
    const admin1 = row.admin1 ? qidOf(row.admin1.value) : null;
    // P131* is reflexive: Tokyo is its own first-level subdivision. A city
    // is not its own region, and a country is not anyone's region.
    if (
      admin1 &&
      admin1 !== qid &&
      !city.countries.includes(admin1) &&
      !city.regions.includes(admin1)
    ) {
      city.regions.push(admin1);
    }
    byQid.set(qid, city);
  }
  for (const city of byQid.values())
    city.regions = city.regions.filter((r) => !city.countries.includes(r));
  return [...byQid.values()];
}

export async function sparql(client, query, { retries = 2 } = {}) {
  const url = `${SPARQL_ENDPOINT}?format=json&query=${encodeURIComponent(query)}`;
  const body = await client.getJson(url, {
    headers: { Accept: "application/sparql-results+json" },
    retries,
  });
  return body.results.bindings;
}

export async function listCountries(client) {
  const rows = await sparql(client, countriesQuery());
  const byIso = new Map();
  for (const row of rows) {
    const iso = row.iso.value.toUpperCase();
    if (!byIso.has(iso)) byIso.set(iso, qidOf(row.country.value));
  }
  return [...byIso.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([iso2, qid]) => ({ iso2, qid }));
}

/**
 * Labels, English Wikipedia titles, demonyms (P1549), ISO codes (P297) and
 * the English article of each "culture of" item (P2596), 200 items per
 * SPARQL query.
 *
 * SPARQL rather than `wbgetentities`: the Query Service sits outside the API
 * gateway's per-identity rate limits, which refused every Action API request
 * from an agent container on 2026-11-17, and one query here replaces four
 * wbgetentities calls plus a second round trip for the culture titles.
 * `wdt:` only ever yields best-rank statements, so deprecated values are out.
 */
export function entityDetailsQuery(qids) {
  const values = qids.map((q) => {
    if (!/^Q\d+$/.test(q)) throw new Error(`not a Wikidata item id: ${q}`);
    return `wd:${q}`;
  });
  return `SELECT ?item ?label ?article ?iso ?demonym ?cultureArticle WHERE {
  VALUES ?item { ${values.join(" ")} }
  OPTIONAL { ?item rdfs:label ?label . FILTER(LANG(?label) = "en") }
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . }
  OPTIONAL { ?item wdt:P297 ?iso }
  OPTIONAL { ?item wdt:P1549 ?demonym . FILTER(LANG(?demonym) = "en") }
  OPTIONAL { ?item wdt:P2596 ?culture . ?cultureArticle schema:about ?culture ; schema:isPartOf <https://en.wikipedia.org/> . }
}`;
}

export function mergeEntityRows(bindings) {
  const details = new Map();
  for (const row of bindings) {
    const qid = qidOf(row.item.value);
    const d = details.get(qid) ?? {
      qid,
      label: null,
      title: null,
      demonyms: [],
      iso2: null,
      cultureTitles: [],
    };
    d.label ??= row.label?.value ?? null;
    d.title ??= row.article ? titleFromArticleUrl(row.article.value) : null;
    d.iso2 ??= row.iso?.value ?? null;
    if (row.demonym && !d.demonyms.includes(row.demonym.value)) d.demonyms.push(row.demonym.value);
    const culture = row.cultureArticle ? titleFromArticleUrl(row.cultureArticle.value) : null;
    if (culture && !d.cultureTitles.includes(culture)) d.cultureTitles.push(culture);
    details.set(qid, d);
  }
  return details;
}

export async function entityDetails(client, qids) {
  const unique = [...new Set(qids)];
  const details = new Map();
  for (let i = 0; i < unique.length; i += 200) {
    const rows = await sparql(client, entityDetailsQuery(unique.slice(i, i + 200)));
    for (const [qid, d] of mergeEntityRows(rows)) details.set(qid, d);
  }
  return details;
}

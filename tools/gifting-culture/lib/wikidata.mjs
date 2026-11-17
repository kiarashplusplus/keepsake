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
export const WIKIDATA_API = "https://www.wikidata.org/w/api.php";

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

function englishMonolingual(claims, property) {
  return (claims?.[property] ?? [])
    .filter((c) => c.rank !== "deprecated")
    .map((c) => c.mainsnak?.datavalue?.value)
    .filter((v) => v?.language === "en" && v.text)
    .map((v) => v.text);
}

function itemValues(claims, property) {
  return (claims?.[property] ?? [])
    .filter((c) => c.rank !== "deprecated")
    .map((c) => c.mainsnak?.datavalue?.value?.id)
    .filter(Boolean);
}

function stringValues(claims, property) {
  return (claims?.[property] ?? [])
    .filter((c) => c.rank !== "deprecated")
    .map((c) => c.mainsnak?.datavalue?.value)
    .filter((v) => typeof v === "string");
}

/**
 * Labels, English Wikipedia titles, demonyms (P1549), ISO codes (P297) and
 * "culture of" items (P2596) for a set of items, 50 per API call.
 */
export async function entityDetails(client, qids) {
  const details = new Map();
  const unique = [...new Set(qids)];
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    // No `maxlag`: it exists to slow down *edits*, and Wikidata's lag figure
    // folds in query-service lag that can sit above 5 s for hours. With it,
    // the first real run of this tool failed nine read attempts in a row.
    const url =
      `${WIKIDATA_API}?action=wbgetentities&format=json&formatversion=2` +
      `&props=labels|sitelinks|claims&languages=en&sitefilter=enwiki&ids=${batch.join("|")}`;
    const body = await client.getJson(url);
    for (const [qid, entity] of Object.entries(body.entities ?? {})) {
      if (entity.missing !== undefined) continue;
      details.set(qid, {
        qid,
        label: entity.labels?.en?.value ?? null,
        title: entity.sitelinks?.enwiki?.title ?? null,
        demonyms: englishMonolingual(entity.claims, "P1549"),
        iso2: stringValues(entity.claims, "P297")[0] ?? null,
        cultureItems: itemValues(entity.claims, "P2596"),
      });
    }
  }
  return details;
}

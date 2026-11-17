/**
 * Location records: the Wikidata merge, and the scope/coverage contract the
 * story layer will lean on.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mergeCityRows, citiesQuery } from "../lib/wikidata.mjs";
import { compileCity, coverageLevel, cityFileName, slugify } from "../lib/compile.mjs";
import { shortName, templateTitles, searchQueries } from "../lib/sources.mjs";

const uri = (q) => ({ value: `http://www.wikidata.org/entity/${q}` });
const row = (city, extra = {}) => ({
  city: uri(city),
  article: { value: "https://en.wikipedia.org/wiki/Saitama_(city)" },
  country: uri("Q17"),
  ...extra,
});

test("mergeCityRows: one record per city, max population, every region kept", () => {
  const [city, ...rest] = mergeCityRows([
    row("Q134635", { pop: { value: "1300000" }, admin1: uri("Q128186") }),
    row("Q134635", {
      pop: { value: "1325843" },
      coord: { value: "Point(139.645 35.861)" },
      admin1: uri("Q128186"),
    }),
  ]);
  assert.equal(rest.length, 0);
  assert.equal(city.title, "Saitama (city)");
  assert.equal(city.population, 1325843);
  assert.deepEqual(city.coordinates, { lat: 35.861, lng: 139.645 });
  assert.deepEqual(city.regions, ["Q128186"]);
});

test("mergeCityRows: a city is not its own region, a country is nobody's region", () => {
  const [tokyo] = mergeCityRows([
    row("Q1490", { admin1: uri("Q1490") }),
    row("Q1490", { admin1: uri("Q17") }),
  ]);
  assert.deepEqual(tokyo.regions, []);
});

test("mergeCityRows: a city claimed by two countries keeps both", () => {
  const [city] = mergeCityRows([
    row("Q1218", { country: uri("Q801") }),
    row("Q1218", { country: uri("Q219060") }),
  ]);
  assert.deepEqual(city.countries, ["Q801", "Q219060"]);
});

test("citiesQuery refuses anything that is not an ISO code (it is interpolated into SPARQL)", () => {
  assert.throws(() => citiesQuery({ iso2: 'JP" } #', minPopulation: 1 }), /ISO 3166/);
});

test("names and probes", () => {
  assert.equal(shortName("Georgia (country)"), "Georgia");
  assert.equal(shortName("Kawasaki, Kanagawa"), "Kawasaki");
  assert.ok(
    templateTitles({ kind: "country", title: "United States" }).includes(
      "Culture of the United States",
    ),
  );
  assert.ok(templateTitles({ kind: "country", title: "Japan" }).includes("Etiquette in Japan"));
  assert.ok(
    !templateTitles({ kind: "city", title: "Osaka" }).some((t) => t.startsWith("Etiquette")),
  );
  assert.deepEqual(searchQueries({ title: "Japan", demonyms: ["Japanese"] }), [
    '"Japan" gift-giving tradition',
    '"Japanese" gifts custom',
  ]);
  assert.equal(slugify("Hyōgo Prefecture"), "hyogo-prefecture");
  assert.equal(cityFileName({ title: "Saitama (city)", qid: "Q134635" }), "saitama--Q134635.json");
});

const passage = (id, extra = {}) => ({
  id,
  headingPath: [],
  text: `text ${id}`,
  giftSentences: [],
  matchedBy: "paragraph",
  giftTerms: ["gift"],
  subjectMentions: [],
  tags: { occasions: {}, practices: {} },
  weak: false,
  source: {
    title: "Some article",
    revisionId: 1,
    revisionTimestamp: "2026-01-01T00:00:00Z",
    discoveredBy: "search",
  },
  ...extra,
});
const subject = (qid, kind, title) => ({ qid, kind, title });

test("compileCity: narrowest scope wins a duplicate; weak passages never set the level", () => {
  const osaka = subject("Q35765", "city", "Osaka");
  const japan = { ...subject("Q17", "country", "Japan"), iso2: "JP" };
  const record = compileCity({
    city: { ...osaka, label: "Osaka", population: 1, coordinates: null, demonyms: [] },
    regions: [],
    countries: [japan],
    generatedAt: "2026-11-17T00:00:00Z",
    collections: {
      city: { subject: osaka, passages: [passage("a", { weak: true }), passage("shared")] },
      regions: [],
      countries: [{ subject: japan, passages: [passage("shared"), passage("c")] }],
    },
  });
  assert.deepEqual(
    record.passages.map((p) => [p.id, p.scope]),
    [
      ["a", "city"],
      ["shared", "city"],
      ["c", "country"],
    ],
  );
  // The fixture's passages are search hits (a mention, not a documented
  // source): they set levelWithMentions, never level.
  assert.equal(record.coverage.level, "none");
  assert.equal(record.coverage.levelWithMentions, "city");
  assert.deepEqual(record.coverage.strongPassages, { city: 1, region: 0, country: 1 });
  assert.equal(record.sources[0].revisionUrl, "https://en.wikipedia.org/w/index.php?oldid=1");
  assert.equal(record.sources[0].license.name, "CC BY-SA 4.0");
  assert.equal(record.location.countries[0].iso2, "JP");
});

test("coverageLevel: weak passages never count; mentions count only for levelWithMentions", () => {
  const p = (scope, weak, discoveredBy = "place-article") => ({
    scope,
    weak,
    source: { discoveredBy },
  });
  assert.equal(coverageLevel([p("city", true), p("country", false)]), "country");
  assert.equal(coverageLevel([p("city", true)]), "none");
  assert.equal(coverageLevel([]), "none");
  const mixed = [p("city", false, "corpus-mention"), p("country", false, "culture-article")];
  assert.equal(coverageLevel(mixed), "country");
  assert.equal(coverageLevel(mixed, { includeMentions: true }), "city");
  assert.equal(coverageLevel([p("city", false, "about-title")]), "city");
});

test("weak country passages are counted, not copied into every city", () => {
  const city = subject("Q35765", "city", "Osaka");
  const japan = { ...subject("Q17", "country", "Japan"), iso2: "JP" };
  const record = compileCity({
    city: { ...city, label: "Osaka", population: 1, coordinates: null, demonyms: [] },
    regions: [],
    countries: [japan],
    generatedAt: "t",
    collections: {
      city: { subject: city, passages: [passage("cw", { weak: true })] },
      regions: [],
      countries: [
        { subject: japan, passages: [passage("weak1", { weak: true }), passage("strong1")] },
      ],
    },
  });
  assert.deepEqual(
    record.passages.map((p) => p.id),
    ["cw", "strong1"],
    "a weak city passage is kept; a weak country one is not",
  );
  assert.equal(record.coverage.omittedWeakCountryPassages, 1);
});

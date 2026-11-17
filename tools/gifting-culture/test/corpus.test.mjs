/**
 * The dump scan and the corpus-backed collector: page parsing, chunk
 * planning, the pre-filters (which must never be stricter than the lexicon
 * they guard), and how corpus paragraphs are assigned to places.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pagesFromText, parsePage, planChunks } from "../lib/dump.mjs";
import { mightBeAboutGifts, pageRows } from "../lib/corpus.mjs";
import { collectFromCorpus, indexCorpus } from "../lib/corpus-sources.mjs";
import { mergeEntityRows } from "../lib/wikidata.mjs";

const pageXml = (title, text, { ns = 0, id = 1, redirect } = {}) =>
  `<page>\n<title>${title}</title>\n<ns>${ns}</ns>\n<id>${id}</id>\n${redirect ? `<redirect title="${redirect}" />\n` : ""}<revision>\n<id>${id}00</id>\n<timestamp>2026-11-01T00:00:00Z</timestamp>\n<text bytes="1" xml:space="preserve">${text}</text>\n</revision>\n</page>`;

test("parsePage decodes the dump's XML escaping", () => {
  const page = parsePage(pageXml("Q&amp;A", "He said &quot;gifts&quot; &lt;ref&gt;", { id: 7 }));
  assert.equal(page.title, "Q&A");
  assert.equal(page.text, 'He said "gifts" <ref>');
  assert.equal(page.revisionId, 700);
});

test("pagesFromText reassembles pages split across chunks", async () => {
  const xml = pageXml("A", "one", { id: 1 }) + pageXml("B", "two", { id: 2 });
  async function* chunks() {
    for (let i = 0; i < xml.length; i += 17) yield xml.slice(i, i + 17);
  }
  const titles = [];
  for await (const p of pagesFromText(chunks())) titles.push(p.title);
  assert.deepEqual(titles, ["A", "B"]);
});

test("planChunks cuts on stream boundaries, by bytes, and covers the file to the last byte", () => {
  // One huge early stream, then small ones: a cut by count would put the
  // huge one plus half the rest in chunk one.
  const offsets = [566, 4000, 4100, 4200, 4300, 4400, 4500, 4600];
  const chunks = planChunks(offsets, 8000, 2);
  assert.deepEqual(
    chunks.map((c) => [c.start, c.end]),
    [
      [566, 4299],
      [4300, 7999],
    ],
  );
  const sizes = chunks.map((c) => c.end - c.start + 1);
  assert.ok(Math.max(...sizes) / Math.min(...sizes) < 1.05, `unbalanced: ${sizes}`);
  for (let i = 1; i < chunks.length; i++)
    assert.equal(chunks[i].start, chunks[i - 1].end + 1, "no gap, no overlap");
  assert.equal(
    chunks.reduce((n, c) => n + c.streams, 0),
    offsets.length,
  );
});

test("the pre-filter never rejects a phrase the lexicon accepts", () => {
  // One example per GIFT_TERMS entry. A phrase here that the pre-filter
  // rejects is a paragraph the corpus silently loses (two did, before this test).
  const examples = [
    "a gift",
    "gift-giving",
    "gift exchange",
    "gifting",
    "regifting",
    "they give presents",
    "a birthday present",
    "a Christmas present",
    "souvenirs",
    "a keepsake",
    "an heirloom",
    "hand-me-downs",
    "wedding favours",
    "red envelopes",
    "red packet",
    "hongbao",
    "hóngbāo",
    "lai see",
    "lucky money",
    "angpao",
    "lì xì",
    "li xi",
    "sebaetdon",
    "otoshidama",
    "eidi",
    "shagun",
    "kōden",
    "omiyage",
    "pasalubong",
    "balikbayan box",
    "ochūgen",
    "oseibo",
    "potlatch",
    "Secret Santa",
    "white elephant gift",
    "Christmas stockings",
    "julklapp",
    "mărțișor",
    "alms",
    "zakat",
    "sadaqah",
    "tzedakah",
  ];
  for (const phrase of examples) {
    const page = { title: "X", ns: 0, text: `In Examplia, people know ${phrase} well.` };
    assert.ok(mightBeAboutGifts(page), `pre-filter dropped: ${phrase}`);
  }
});

test("pageRows: redirects, other namespaces and citation-only mentions yield nothing", () => {
  assert.deepEqual(
    pageRows({ title: "R", ns: 0, redirect: "Gift", text: "#REDIRECT [[Gift]]" }),
    [],
  );
  assert.deepEqual(
    pageRows({ title: "Talk:Gift", ns: 1, text: "Gifts are given in Examplia every year." }),
    [],
  );
  assert.deepEqual(
    pageRows({
      title: "Bridge",
      ns: 0,
      text: "The bridge opened in 1900 and carries a road.<ref>{{cite book|title=The Gift of Bridges}}</ref>",
    }),
    [],
  );
  const rows = pageRows({
    title: "Examplia",
    ns: 0,
    pageId: 3,
    revisionId: 30,
    text: "Visitors bring small gifts to their hosts in Examplia.<ref>x</ref>",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].refs, 1);
});

const article = (title, ...texts) => ({
  title,
  pageId: 1,
  revisionId: 10,
  revisionTimestamp: "t",
  paragraphs: texts.map((text) => ({
    headingPath: [],
    text,
    refs: 1,
    flags: [],
    unknownTemplates: 0,
  })),
});

test("corpus assignment: own article, about-title, and same-sentence mentions only", () => {
  const byTitle = new Map(
    [
      article("Osaka", "In Osaka, merchants traditionally exchange gifts at the new year."),
      article(
        "Christmas in Japan",
        "Couples exchange gifts on Christmas Eve, a custom that spread after the war.",
      ),
      article(
        "Some company",
        "The company was founded in Osaka. Its founder later received many gifts.",
      ),
      article("Sweets", "Boxed sweets from Osaka are a common gift for coworkers after a trip."),
    ].map((a) => [a.title, a]),
  );
  const osaka = { qid: "Q35765", kind: "city", title: "Osaka", demonyms: ["Osakan"] };
  const japan = { qid: "Q17", kind: "country", title: "Japan", demonyms: ["Japanese"] };
  const index = indexCorpus(byTitle, [osaka, japan]);

  const city = collectFromCorpus({ byTitle, index, subject: osaka });
  assert.deepEqual(city.sources.map((s) => [s.title, s.discoveredBy]).sort(), [
    ["Osaka", "place-article"],
    ["Sweets", "corpus-mention"],
  ]);
  const country = collectFromCorpus({ byTitle, index, subject: japan });
  assert.deepEqual(
    country.sources.map((s) => [s.title, s.discoveredBy]),
    [["Christmas in Japan", "about-title"]],
  );
  assert.equal(city.passages[0].rendering.renderer, "dump-wikitext");
  assert.equal(city.passages[0].rendering.refs, 1);
});

test("an ambiguous name counts only where the article also names that place's country or region", () => {
  const byTitle = new Map(
    [
      article("Fallas", "In Valencia, Spain, families exchange gifts during the festival."),
      article("Carabobo customs", "Families in Valencia give gifts at Christmas."),
    ].map((a) => [a.title, a]),
  );
  const spain = { qid: "Q8818", kind: "city", title: "Valencia", demonyms: [] };
  const venezuela = { qid: "Q131095", kind: "city", title: "Valencia, Venezuela", demonyms: [] };
  const context = new Map([
    ["Q8818", ["Spain", "Spanish"]],
    ["Q131095", ["Venezuela", "Venezuelan", "Carabobo"]],
  ]);
  const index = indexCorpus(byTitle, [spain, venezuela], context);
  assert.deepEqual([...(index.mentionTitles.get("Q8818") ?? [])], ["Fallas"]);
  assert.deepEqual([...(index.mentionTitles.get("Q131095") ?? [])], ["Carabobo customs"]);
});

test("mergeEntityRows folds SPARQL rows into one record per item", () => {
  const uri = (q) => ({ value: `http://www.wikidata.org/entity/${q}` });
  const d = mergeEntityRows([
    {
      item: uri("Q17"),
      label: { value: "Japan" },
      article: { value: "https://en.wikipedia.org/wiki/Japan" },
      iso: { value: "JP" },
      demonym: { value: "Japanese" },
      cultureArticle: { value: "https://en.wikipedia.org/wiki/Culture_of_Japan" },
    },
    { item: uri("Q17"), label: { value: "Japan" }, demonym: { value: "Nipponese" } },
  ]).get("Q17");
  assert.deepEqual(d, {
    qid: "Q17",
    label: "Japan",
    title: "Japan",
    demonyms: ["Japanese", "Nipponese"],
    iso2: "JP",
    cultureTitles: ["Culture of Japan"],
  });
});

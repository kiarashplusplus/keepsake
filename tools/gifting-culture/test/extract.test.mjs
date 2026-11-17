/**
 * What the extractor keeps and, mostly, what it refuses. The text fixtures
 * are written for these tests in the shape TextExtracts returns (headings as
 * `== … ==` lines, one paragraph per line); the false positives they guard
 * against are ones real city and country articles contain.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  extractPassages,
  giftTerms,
  isWeak,
  mentionMatcher,
  parseSections,
  splitSentences,
  tagPassage,
} from "../lib/extract.mjs";

const ARTICLE = [
  "Etiquette in Examplia covers the social expectations of everyday life across the country.",
  "",
  "== Gifts and gift-giving ==",
  "Gifts are usually wrapped and offered with both hands, and the recipient often declines once before accepting.",
  "=== Seasonal gifts ===",
  "There are two exchange seasons each year, in summer and in winter, when people thank those who helped them.",
  "== Shopping ==",
  "The old town has many gift shops and souvenir stands selling postcards to tourists in the summer months.",
  "== See also ==",
  "Gift economy and the history of gifts in neighbouring countries are covered in other articles.",
].join("\n");

test("parseSections tracks nested heading paths and skips blank lines", () => {
  const paragraphs = parseSections(ARTICLE);
  assert.deepEqual(
    paragraphs.map((p) => p.headingPath),
    [
      [],
      ["Gifts and gift-giving"],
      ["Gifts and gift-giving", "Seasonal gifts"],
      ["Shopping"],
      ["See also"],
    ],
  );
});

test("a paragraph counts on its own words, or on the heading it sits under", () => {
  const passages = extractPassages({
    title: "Etiquette in Examplia",
    text: ARTICLE,
    subjectNames: ["Examplia"],
    requiresMention: false,
  });
  assert.deepEqual(
    passages.map((p) => p.matchedBy),
    ["paragraph", "heading"],
    "the seasonal paragraph never says 'gift' — it is kept because its heading does",
  );
});

test("gift shops, souvenir stands and 'See also' never count", () => {
  const passages = extractPassages({
    title: "Etiquette in Examplia",
    text: ARTICLE,
    subjectNames: ["Examplia"],
    requiresMention: false,
  });
  assert.ok(!passages.some((p) => /gift shops/.test(p.text)));
  assert.ok(!passages.some((p) => /Gift economy/.test(p.text)));
});

test("giftTerms: real words in, look-alikes and commerce out", () => {
  assert.deepEqual(giftTerms("Children receive red envelopes and gifts."), [
    "red envelopes",
    "gifts",
  ]);
  assert.deepEqual(giftTerms("She was a gifted pianist."), []);
  assert.deepEqual(giftTerms("The museum has a gift shop and sells gift cards."), []);
  assert.deepEqual(
    giftTerms("The mayor presents the annual report."),
    [],
    "'presents' as a verb is not a gift",
  );
  assert.deepEqual(giftTerms("Families exchange presents on Christmas Eve."), [
    "exchange presents",
  ]);
  assert.deepEqual(giftTerms("Travellers bring back omiyage."), ["omiyage"]);
  assert.deepEqual(giftTerms("Heirloom tomatoes grow in the valley."), []);
  assert.deepEqual(giftTerms("A gift shop sells souvenirs, and guests bring gifts."), [
    "souvenirs",
    "gifts",
  ]);
  assert.deepEqual(giftTerms("Gifting in Việt Nam includes lì xì."), ["gifting", "lì xì"]);
});

test("search hits must name the subject in the paragraph or its heading", () => {
  const text = [
    "A red envelope is a monetary gift given during holidays in several East Asian countries.",
    "== Vietnam ==",
    "In Vietnam the envelope is called lì xì and is given to children at Tết.",
    "== China ==",
    "Red envelopes are given at Chinese New Year by married couples to unmarried relatives.",
  ].join("\n");
  const passages = extractPassages({
    title: "Red envelope",
    text,
    subjectNames: ["China", "Chinese"],
    requiresMention: true,
  });
  assert.equal(passages.length, 1, "the lead and the Vietnam section say nothing about China");
  assert.match(passages[0].text, /Chinese New Year/);
  assert.deepEqual(passages[0].subjectMentions.sort(), ["China", "Chinese"]);
});

test("a topic article's own title makes its paragraphs relevant, but still needs a mention when searched", () => {
  const text =
    "Omiyage are souvenirs brought back from a trip.\nIn Japan, travellers buy boxed sweets for their coworkers before going home.";
  const passages = extractPassages({
    title: "Omiyage",
    text,
    subjectNames: ["Japan"],
    requiresMention: true,
  });
  assert.equal(passages.length, 1);
  assert.equal(passages[0].matchedBy, "article-title");
  assert.deepEqual(passages[0].giftTerms, ["omiyage"]);
});

test("mentions are case-sensitive whole words: 'nice' is not Nice, 'Parisian' is not Paris", () => {
  const match = mentionMatcher(["Nice", "Paris"]);
  assert.deepEqual(match("It is a nice gift."), []);
  assert.deepEqual(match("Parisian bakeries sell gifts."), []);
  assert.deepEqual(match("In Nice and Paris, gifts are wrapped."), ["Nice", "Paris"]);
});

test("splitSentences survives abbreviations", () => {
  assert.deepEqual(
    splitSentences(
      "On St. Nicholas Day children get sweets. In the U.S. Christmas is bigger. Done.",
    ),
    ["On St. Nicholas Day children get sweets.", "In the U.S. Christmas is bigger.", "Done."],
  );
});

test("tags name the word that earned them", () => {
  const tags = tagPassage(
    "At Chinese New Year, red envelopes of money are given; giving clocks is avoided.",
  );
  assert.deepEqual(tags.occasions["lunar-new-year"], ["chinese new year"]);
  assert.deepEqual(tags.practices.money, ["envelopes", "money"]);
  assert.deepEqual(tags.practices.taboo, ["avoided"]);
});

test("a diplomatic gift with no occasion is weak; a custom is not", () => {
  const statue = tagPassage("The statue was a gift from France to the United States.");
  assert.ok(statue.practices["civic-or-diplomatic"]);
  assert.equal(isWeak(statue), true);
  assert.equal(isWeak(tagPassage("Guests bring a small gift when visiting a home.")), false);
  assert.equal(isWeak(tagPassage("Many gifts were given at weddings.")), false);
});

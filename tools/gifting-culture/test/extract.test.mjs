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

// Real sentences the first corpus sample filed under Japanese cities, each a
// false claim of city-level gifting culture before the rule beside it existed.
test("a capitalised gift word mid-sentence is a name, not a gift", () => {
  assert.deepEqual(giftTerms("Scraping Tokyo '95 CD (Gift Records 1995; Live)"), []);
  assert.deepEqual(giftTerms("offices at key centres including GIFT City Gandhinagar."), []);
  assert.deepEqual(giftTerms("held a solo ice show titled Gift at Tokyo Dome."), []);
  assert.deepEqual(
    giftTerms('recordings including "Souvenirs from Tokyo".'),
    ["souvenirs"],
    "a quoted title opening with the word is ambiguous; it stays",
  );
  assert.deepEqual(
    giftTerms("Gifts are opened later."),
    ["gifts"],
    "sentence start is the word itself",
  );
  assert.deepEqual(giftTerms("Christmas presents and gifts"), ["christmas presents", "gifts"]);
});

test("civic, institutional and commercial gifts are weak; customs are not", () => {
  const weak = (s) => isWeak(tagPassage(s));
  assert.equal(
    weak(
      "In 1959, the first Japanese Somei-Yoshino Cherry Tree was planted in High Park, a gift from the citizens of Tokyo.",
    ),
    true,
  );
  assert.equal(
    weak(
      "The Commemorative Garden is a Japanese garden that was built as a gift to residents of the City of Gosford by the Ward of Edogawa, Tokyo, Japan.",
    ),
    true,
  );
  assert.equal(
    weak(
      '"Seien", a Japanese garden designed by Kenzo Ogata of Tokyo, was a 1963 gift of Japanese business leaders.',
    ),
    true,
  );
  assert.equal(
    weak(
      "Shopping Plaza HAYAMA STATION is a shopping plaza featuring local produce, foods, souvenirs, and small retailers.",
    ),
    true,
  );
  assert.equal(
    weak("The library houses editions of The Tale of Genji that were bequeathed to the city."),
    true,
  );
  assert.equal(
    weak(
      "Nama yatsuhashi is a very popular souvenir of Kyoto; 89.2% of tourists who visited Kyoto bought souvenirs.",
    ),
    false,
  );
  assert.equal(
    weak(
      "In Japan, Valentine's Day gift giving was introduced by Morozoff Ltd. in 1936, near Kobe.",
    ),
    false,
  );
});

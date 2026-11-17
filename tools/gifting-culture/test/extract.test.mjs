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
    subjectDemonyms: ["Chinese"],
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
    [],
    "a quoted title mid-sentence",
  );
  assert.deepEqual(
    giftTerms('"Gifts are opened at home," she said.'),
    ["gifts"],
    "a quotation opening a sentence",
  );
  assert.deepEqual(giftTerms("the carriage of souvenir mail between Lakehurst and Tokyo"), []);
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

test("tags describe the gift sentences, not their neighbours", () => {
  const [passage] = extractPassages({
    title: "Gosford",
    text: "The garden was built as a gift to residents of the City of Gosford by the Ward of Edogawa, Tokyo. The gallery hosts the annual Gosford Art Prize.",
    subjectNames: ["Tokyo"],
    requiresMention: true,
  });
  assert.deepEqual(Object.keys(passage.tags.practices), ["civic-or-diplomatic"]);
  assert.equal(passage.weak, true);
});

test("an heirloom handed to an institution is institutional, not a family custom", () => {
  const tags = tagPassage(
    "The Hōsa Library houses historic editions of The Tale of Genji that are an heirloom of the Owari Tokugawa and were bequeathed to the city.",
  );
  assert.equal(isWeak(tags), true);
  assert.equal(
    isWeak(tagPassage("The quilt is an heirloom passed down from mother to daughter.")),
    false,
  );
});

// From a random sample of city-level corpus mentions in the full dump: one-off
// events, titles and foreign words that set a city's coverage before this rule.
test("a corpus mention counts only when it describes a recurring practice", () => {
  const strong = (title, text, names) =>
    extractPassages({
      title,
      text,
      subjectNames: names,
      requiresMention: true,
      mentionScope: "sentence",
      requireCustomLanguage: true,
    }).map((p) => [p.weak, p.weakReason]);
  assert.deepEqual(
    strong(
      "Rolex",
      "In Singapore in 1998 a man murdered a beautician to steal her Rolex and give it to his girlfriend as a birthday present.",
      ["Singapore"],
    ),
    [[true, "no habitual language"]],
  );
  assert.deepEqual(
    strong(
      "Boys' Brigade in Singapore",
      "Share-a-Gift is a major annual event held in Singapore during the Christmas period, collecting gifts for the needy.",
      ["Singapore"],
    ),
    [[false, null]],
  );
  assert.deepEqual(
    strong(
      "Wagashi",
      "Nama yatsuhashi is a very popular souvenir of Kyoto, bought by most tourists.",
      ["Kyoto"],
    ),
    [[false, null]],
  );
});

test("French souvenir (memory) and romanised names are not gift words", () => {
  assert.deepEqual(giftTerms("Nocturne: Souvenir de Milan, Op. 70"), []);
  assert.deepEqual(giftTerms("group exhibition Fais un effort pour te souvenir."), []);
  assert.deepEqual(
    giftTerms("Assumption Junior College (Seibo Hishōten Gakuin) was a college in Osaka."),
    [],
  );
  assert.deepEqual(giftTerms("At year end, oseibo gifts are sent to superiors."), [
    "oseibo",
    "gifts",
  ]);
});

// Name collisions from a random sample of city-level mentions in the full dump.
test("a place name inside a longer proper noun is not a mention of the place", () => {
  const match = mentionMatcher(["Salvador", "Adelaide", "Manila", "Tokyo"]);
  assert.deepEqual(
    match("Some countries, in particular El Salvador, have a tradition called Amigo secreto."),
    [],
  );
  assert.deepEqual(match("Adelaide D. Thayer recalled making gifts each year."), []);
  assert.deepEqual(match("I Gusti Kompyang Manila accepted the gift."), []);
  assert.deepEqual(match("She held an ice show at Tokyo Dome."), []);
  assert.deepEqual(
    match("In Tokyo, gifts are exchanged."),
    ["Tokyo"],
    "a leading preposition is not part of the name",
  );
  assert.deepEqual(
    match("Visitors to Salvador, Bahia buy souvenirs."),
    ["Salvador"],
    "a comma ends the name",
  );
});

test("a Title Case gift phrase mid-sentence is a name", () => {
  assert.deepEqual(giftTerms("In April, the Wedding Present toured Australia."), []);
  assert.deepEqual(giftTerms("Couples exchange Christmas presents."), ["christmas presents"]);
});

test("selling souvenirs is commerce", () => {
  assert.equal(
    isWeak(tagPassage("The work was shipped to Egypt to be sold as souvenirs to tourists.")),
    true,
  );
});

test("a demonym is an adjective: a capital after it does not make it a longer name", () => {
  const match = mentionMatcher(["Japan", "Japanese"], { adjectives: ["Japanese"] });
  assert.deepEqual(match("The Japanese Valentine custom spread in the 1970s."), ["Japanese"]);
  assert.deepEqual(match("Japan Airlines sells gifts."), []);
});

// Judged by hand: every city-level passage from a place's own article in the
// full dump. Events and objects on the left; customs on the right.
test("habitual language separates customs from events, everywhere", () => {
  const strong = (text) =>
    extractPassages({ title: "Place", text, subjectNames: [], requiresMention: false }).map(
      (p) => p.weak === false,
    );
  assert.deepEqual(
    strong(
      "Cortés and Moctezuma II met on the causeway; they exchanged gifts, but the camaraderie did not last.",
    ),
    [false],
  );
  assert.deepEqual(
    strong("Thousands came to gawk at the scene, collecting keepsakes and posing for photographs."),
    [false],
  );
  assert.deepEqual(
    strong(
      "The Volgograd Planetarium was a gift from East Germany in honor of Stalin's 70th birthday.",
    ),
    [false],
  );
  assert.deepEqual(
    strong(
      "Communities still practise traditional crafts, including the production of masks and alms bowls.",
    ),
    [],
  );
  assert.deepEqual(
    strong(
      "Gifts and visits are exchanged among friends and relatives and children receive lai see, lucky money.",
    ),
    [true],
  );
  assert.deepEqual(
    strong("Winter customs include staying up on New Year's Eve and giving lucky money."),
    [true],
  );
  assert.deepEqual(
    strong(
      "Both groom and bride need to prepare 12 specific gifts representing different meanings during their engagement ceremony, with more to come in the wedding.",
    ),
    [true],
  );
});

/**
 * What counts as "about gifting", and how a matched passage is tagged.
 *
 * Everything here is deterministic on purpose. The pipeline's output is
 * meant to be *neutral data* — verbatim Wikipedia text plus labels a person
 * can audit — and the tone-sensitive story layer comes later. A model in
 * this step would be a second author whose voice nobody calibrated.
 *
 * Tuning this file is the main way to trade recall for precision. Every
 * change should come with a case in `test/lexicon.test.mjs`, including the
 * false positive it is meant to stop (the existing ones are real: "gift
 * shop", "gifted student", "a gift from France" all appear in city articles).
 */

/**
 * Terms that make a sentence relevant on their own. Matched case-
 * insensitively against Unicode text; `\b` is not Unicode-aware in JS, so
 * each pattern is wrapped with explicit letter look-arounds by `compile()`.
 */
export const GIFT_TERMS = [
  // The core vocabulary.
  "gifts?",
  "gift[- ]giving",
  "gift[- ]exchanges?",
  "gifting",
  "regift(?:ing|ed)?",
  // "presents" only where it is clearly the noun — "the mayor presents" is not a gift.
  "(?:give|gives|giving|gave|given|exchange|exchanges|exchanging|exchanged|receive|receives|received|receiving|open|opens|opening|opened|wrap|wraps|wrapping|wrapped|buy|buys|buying|bought|bring|brings|bringing|brought)\\s+(?:their\\s+|small\\s+|the\\s+)?presents",
  "(?:christmas|birthday|wedding|holiday|new year'?s?|housewarming|farewell)\\s+presents?",
  "souvenirs?",
  "keepsakes?",
  "heirlooms?",
  "hand-me-downs?",
  "wedding favou?rs",
  // Money given as a gift, by name.
  "red (?:packets?|envelopes?)",
  "hongbao",
  "hóngbāo",
  "lai see",
  "lucky money",
  "ang ?pao",
  "lì xì",
  "li xi",
  "sebaetdon",
  "otoshidama",
  "eidi(?:ya)?",
  "shagun",
  "k[oō]den",
  // Named gifting customs.
  "omiyage",
  "pasalubong",
  "balikbayan box(?:es)?",
  "(?:o)?ch[uū]gen",
  "(?:o)?seibo",
  "potlatch(?:es)?",
  "secret santa",
  "white elephant gift",
  "christmas stockings?",
  "julklapp",
  "m[aă]r[tț]i[sș]or",
  // Giving as charity. Tagged `charity` so a story layer can keep it apart.
  "alms(?:giving)?",
  "zakat",
  "sadaqah",
  "tzedakah",
];

/**
 * Phrases containing a gift term that are *not* about the culture of giving.
 * A sentence whose only matches sit inside one of these does not count.
 */
export const EXCLUDED_PHRASES = [
  "gift shops?",
  "gift stores?",
  "gift cards?",
  "gift certificates?",
  "gift vouchers?",
  "gift tax(?:es)?",
  "gift aid",
  "gift wrap(?:ping)? (?:paper|department)",
  "souvenir shops?",
  "souvenir stands?",
  "souvenir stores?",
  "heirloom (?:tomato(?:es)?|varieties|variety|seeds?|vegetables?|plants?)",
  "zakat (?:fund|board|department|ministry)",
];

/**
 * Tags are labels, not verdicts. Each lists the patterns that earn it; the
 * extractor records which term fired so a reviewer can see why.
 */
export const OCCASIONS = {
  christmas: ["christmas", "xmas", "yuletide", "noël"],
  "new-year": ["new year'?s?", "hogmanay", "nowruz", "norouz", "rosh hashanah"],
  "lunar-new-year": ["lunar new year", "chinese new year", "spring festival", "t[eế]t", "seollal"],
  "saint-nicholas": ["sinterklaas", "saint nicholas", "st\\.? nicholas", "nikolaus"],
  epiphany: ["epiphany", "three kings", "reyes magos", "befana"],
  eid: ["eid", "eid al-fitr", "eid al-adha", "hari raya", "bayram"],
  ramadan: ["ramadan", "ramazan"],
  diwali: ["diwali", "deepavali"],
  hanukkah: ["hanukkah", "chanukah"],
  "valentines-day": ["valentine'?s"],
  "mothers-day": ["mother'?s day"],
  birthday: ["birthdays?", "kanreki"],
  wedding: ["weddings?", "marriages?", "brides?", "grooms?", "engagements?"],
  birth: ["newborns?", "baby showers?", "births?"],
  funeral: ["funerals?", "mourning", "condolences?", "wakes?", "k[oō]den"],
  housewarming: ["housewarming", "new homes?", "newly opened"],
  seasonal: ["(?:o)?ch[uū]gen", "(?:o)?seibo", "mid-year", "year-end"],
  travel: [
    "souvenirs?",
    "omiyage",
    "pasalubong",
    "trips?",
    "travell?(?:ed|ing|ers?)?",
    "holiday-goers?",
    "balikbayan",
  ],
  "coming-of-age": [
    "coming of age",
    "coming-of-age",
    "quincea[nñ]era",
    "bar mitzvah",
    "bat mitzvah",
    "first communion",
  ],
  graduation: ["graduations?"],
};

export const PRACTICES = {
  money: [
    "money",
    "cash",
    "banknotes?",
    "envelopes?",
    "hongbao",
    "lucky money",
    "otoshidama",
    "eidi(?:ya)?",
    "shagun",
    "k[oō]den",
    "ang ?pao",
    "lì xì",
    "sebaetdon",
  ],
  "host-gift": ["guests?", "hosts?", "hostess", "visiting", "visitors?", "housewarming"],
  souvenir: ["souvenirs?", "omiyage", "pasalubong"],
  reciprocity: [
    "reciproc\\w*",
    "return gifts?",
    "in return",
    "obligations?",
    "obliged",
    "okaeshi",
    "repay\\w*",
    "owe\\w*",
  ],
  presentation: [
    "wrap\\w*",
    "both hands",
    "open(?:ed|s|ing)? (?:the|a) gifts?",
    "in front of",
    "refus\\w*",
    "declin\\w*",
    "presented with",
  ],
  taboo: [
    "avoid\\w*",
    "taboo",
    "inappropriate",
    "not appropriate",
    "unlucky",
    "bad luck",
    "rude",
    "impolite",
    "should not",
    "never give",
    "offensive",
  ],
  exchange: ["exchang\\w*", "secret santa", "swap\\w*", "white elephant"],
  charity: [
    "alms(?:giving)?",
    "zakat",
    "sadaqah",
    "tzedakah",
    "charit\\w*",
    "the poor",
    "donat\\w*",
  ],
  heirloom: ["heirlooms?", "keepsakes?", "hand-me-downs?", "passed down", "inherit\\w*"],
  "civic-or-diplomatic": [
    "gift from the (?:people|government|city|nation|king|queen|emperor)",
    "(?:was|were) (?:a )?gifts? (?:from|to) (?:the )?\\p{Lu}\\p{L}*",
    "sister cit(?:y|ies)",
    "diplomatic gifts?",
    "presented to the city",
  ],
  commercial: [
    "shops?",
    "shopping",
    "retail\\w*",
    "stores?",
    "sales",
    "market\\w*",
    "brands?",
    "advertis\\w*",
  ],
};

/**
 * Section headings that are never about the subject's culture. Paragraphs
 * under them are skipped wholesale.
 */
export const SKIPPED_SECTIONS = [
  "see also",
  "references",
  "notes",
  "citations",
  "sources",
  "bibliography",
  "further reading",
  "external links",
  "footnotes",
  "works cited",
  "gallery",
];

const LETTER = "\\p{L}\\p{N}";

/** Wrap a pattern so it only matches whole words (Unicode-aware). */
function wordPattern(source) {
  return `(?<![${LETTER}])(?:${source})(?![${LETTER}])`;
}

/** Compile a list of patterns into one global, case-insensitive, Unicode regex. */
export function compile(patterns, { caseSensitive = false } = {}) {
  return new RegExp(patterns.map(wordPattern).join("|"), caseSensitive ? "gu" : "giu");
}

export const GIFT_RE = compile(GIFT_TERMS);
export const EXCLUDED_RE = compile(EXCLUDED_PHRASES);

const compileTags = (table) =>
  Object.fromEntries(
    Object.entries(table).map(([tag, patterns]) => [
      tag,
      // civic-or-diplomatic needs a capital letter to mean "a proper noun",
      // so those patterns are matched case-sensitively.
      tag === "civic-or-diplomatic"
        ? compile(patterns, { caseSensitive: true })
        : compile(patterns),
    ]),
  );

export const OCCASION_RES = compileTags(OCCASIONS);
export const PRACTICE_RES = compileTags(PRACTICES);

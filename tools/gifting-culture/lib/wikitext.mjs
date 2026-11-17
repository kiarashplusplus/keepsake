/**
 * Wikitext → paragraphs, for the dump path.
 *
 * The API path gets plain text from MediaWiki itself (TextExtracts), which
 * renders templates properly. The dump only has wikitext, so this module does
 * the rendering, and it can only approximate it: a template it does not know
 * is dropped. Three things keep that honest:
 *
 * - Every paragraph reports `unknownTemplates`: how many unrecognised inline
 *   templates were removed from it. A passage with a gap where a
 *   `{{convert}}` or a date used to be is marked, not silently clean.
 * - `test/wikitext.test.mjs` pins the rendering of the constructs that
 *   gifting passages actually use.
 * - `tools/gifting-culture/fidelity.mjs` compares this module's paragraphs with
 *   TextExtracts' for the same revision, and its result is in README.md.
 *
 * What the API path never had and this one does: each paragraph's reference
 * count and its maintenance flags ("citation needed", "dubious", …), which
 * TextExtracts strips before anyone can see them.
 */

const REF = "\u0001";
const FLAG_OPEN = "\u0002";
const FLAG_CLOSE = "\u0003";
const UNKNOWN = "\u0004";

/** Inline maintenance templates: kept as flags on the paragraph, never as text. */
const MAINTENANCE = new Map(
  Object.entries({
    "citation needed": "citation-needed",
    cn: "citation-needed",
    fact: "citation-needed",
    "citation needed span": "citation-needed",
    "cn span": "citation-needed",
    "better source needed": "better-source-needed",
    "better source": "better-source-needed",
    "unreliable source?": "better-source-needed",
    "self-published inline": "better-source-needed",
    dubious: "dubious",
    "dubious span": "dubious",
    "failed verification": "failed-verification",
    "verification needed": "failed-verification",
    "according to whom": "attribution-needed",
    "by whom": "attribution-needed",
    "attribution needed": "attribution-needed",
    "who?": "attribution-needed",
    who: "attribution-needed",
    "weasel inline": "attribution-needed",
    "peacock inline": "peacock",
    "when?": "date-needed",
    when: "date-needed",
    clarify: "clarify",
    vague: "clarify",
    "original research inline": "original-research",
    "or inline": "original-research",
    "page needed": "page-needed",
  }),
);

/** Templates whose output is no part of the prose. Dropped without counting. */
const SILENT = new Set(
  [
    "sfn",
    "sfnp",
    "sfnm",
    "efn",
    "efn-ua",
    "efn-lr",
    "refn",
    "r",
    "rp",
    "harvnb",
    "harvp",
    "harv",
    "notetag",
    "ref label",
    "note label",
    "short description",
    "use dmy dates",
    "use mdy dates",
    "use british english",
    "use american english",
    "use indian english",
    "use australian english",
    "use canadian english",
    "main",
    "main article",
    "see also",
    "further",
    "further information",
    "about",
    "redirect",
    "distinguish",
    "for",
    "other uses",
    "coord",
    "commons category",
    "portal",
    "reflist",
    "authority control",
    "toc limit",
    "clear",
    "clr",
    "anchor",
    "multiple image",
    "image",
    "listen",
    "wide image",
    "pp",
    "pp-protected",
    "pp-semi-indef",
    "pp-move-indef",
    "good article",
    "featured article",
    "engvarb",
    "italic title",
    "lowercase title",
    "dead link",
    "cbignore",
    "webarchive",
    "update",
    "update inline",
    "as of?",
    "inflation-fn",
    "cite web",
    "cite book",
    "cite news",
    "cite journal",
    "citation",
    "cite encyclopedia",
    "cite magazine",
    "efn-lg",
    "ipa",
    "ipac-en",
    "ipa-ja",
    "ipa-zh",
    "respell",
    "audio",
    "pronunciation",
    "lang-rtl",
    "circa?",
    "nbsp;",
    "toc",
    "-",
    "hidden begin",
    "hidden end",
    "col-begin",
    "col-end",
    "col-break",
    "div col",
    "div col end",
    "refbegin",
    "refend",
    "sticky header",
    "snd?",
    "ref",
  ].map((s) => s.toLowerCase()),
);

const SILENT_PREFIXES = [
  "infobox",
  "navbox",
  "sidebar",
  "pp-",
  "use ",
  "cite ",
  "taxobox",
  "speciesbox",
  "campaignbox",
  "s-",
  "wikt",
  "commons",
  "wiki",
  "multiple issues",
  "more citations",
  "unreferenced",
  "refimprove",
  "expand",
  "cleanup",
  "copy edit",
  "stub",
  "-stub",
  "update",
  "outdated",
  "tone",
  "pov",
  "globalize",
  "too few",
  "lead",
  "split",
  "merge",
  "advert",
];

const CHARACTER_TEMPLATES = new Map(
  Object.entries({
    "'": "'",
    "''": "''",
    "!": "|",
    "=": "=",
    snd: " – ",
    "spaced ndash": " – ",
    ndash: "–",
    mdash: "—",
    "spaced en dash": " – ",
    nbsp: " ",
    thinsp: " ",
    dot: " · ",
    middot: "·",
    "•": " • ",
    "en dash": "–",
    "em dash": "—",
  }),
);

/** Names {{langx}} and {{lang-xx}} print before the text ("Ancient Greek: ξενία"). */
const LANGUAGE_NAMES = {
  grc: "Ancient Greek",
  el: "Greek",
  la: "Latin",
  ja: "Japanese",
  zh: "Chinese",
  "zh-hans": "Chinese",
  "zh-hant": "Chinese",
  yue: "Cantonese",
  ko: "Korean",
  vi: "Vietnamese",
  th: "Thai",
  fr: "French",
  de: "German",
  es: "Spanish",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  ru: "Russian",
  uk: "Ukrainian",
  pl: "Polish",
  cs: "Czech",
  sv: "Swedish",
  no: "Norwegian",
  nb: "Norwegian Bokmål",
  da: "Danish",
  fi: "Finnish",
  is: "Icelandic",
  ga: "Irish",
  gd: "Scottish Gaelic",
  cy: "Welsh",
  hu: "Hungarian",
  ro: "Romanian",
  bg: "Bulgarian",
  sr: "Serbian",
  hr: "Croatian",
  tr: "Turkish",
  ar: "Arabic",
  fa: "Persian",
  he: "Hebrew",
  yi: "Yiddish",
  hi: "Hindi",
  ur: "Urdu",
  bn: "Bengali",
  pa: "Punjabi",
  ta: "Tamil",
  te: "Telugu",
  mr: "Marathi",
  gu: "Gujarati",
  kn: "Kannada",
  ml: "Malayalam",
  sa: "Sanskrit",
  ne: "Nepali",
  si: "Sinhala",
  my: "Burmese",
  km: "Khmer",
  lo: "Lao",
  id: "Indonesian",
  ms: "Malay",
  tl: "Tagalog",
  fil: "Filipino",
  sw: "Swahili",
  am: "Amharic",
  yo: "Yoruba",
  ha: "Hausa",
  zu: "Zulu",
  af: "Afrikaans",
  ka: "Georgian",
  hy: "Armenian",
  az: "Azerbaijani",
  kk: "Kazakh",
  uz: "Uzbek",
  mn: "Mongolian",
  bo: "Tibetan",
  ug: "Uyghur",
  ps: "Pashto",
  ku: "Kurdish",
  sq: "Albanian",
  mk: "Macedonian",
  sl: "Slovene",
  sk: "Slovak",
  lt: "Lithuanian",
  lv: "Latvian",
  et: "Estonian",
  eu: "Basque",
  ca: "Catalan",
  gl: "Galician",
  haw: "Hawaiian",
  mi: "Māori",
  sm: "Samoan",
  to: "Tongan",
  qu: "Quechua",
  nah: "Nahuatl",
};

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** HTML entities as they appear in wikitext itself (after XML decoding). */
function decodeHtmlEntities(s) {
  const named = {
    nbsp: " ",
    ndash: "–",
    mdash: "—",
    minus: "−",
    hellip: "…",
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    times: "×",
    deg: "°",
    thinsp: " ",
    ensp: " ",
    emsp: " ",
    zwj: "",
    zwnj: "",
    shy: "",
  };
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
}

/** Split template/link params on `|` at nesting depth 0 (links inside params survive). */
function splitParams(body) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === "[[" || two === "{{") {
      depth++;
      cur += two;
      i++;
    } else if ((two === "]]" || two === "}}") && depth > 0) {
      depth--;
      cur += two;
      i++;
    } else if (body[i] === "|" && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += body[i];
  }
  out.push(cur);
  return out;
}

function positional(params) {
  return params.filter((p) => !/^\s*[\w -]+\s*=/.test(p)).map((p) => p.trim());
}

function named(params, key) {
  const hit = params.find((p) => new RegExp(`^\\s*${key}\\s*=`, "i").test(p));
  return hit ? hit.slice(hit.indexOf("=") + 1).trim() : undefined;
}

/** Render one template whose arguments contain no further templates. */
function renderTemplate(body) {
  const params = splitParams(body);
  const name = params.shift().trim().replace(/_/g, " ").replace(/\s+/g, " ").toLowerCase();
  const args = positional(params);

  if (MAINTENANCE.has(name)) {
    const flag = MAINTENANCE.get(name);
    // The *span* forms wrap text that stays in the prose.
    const spanned = name.endsWith(" span") ? (named(params, "text") ?? args[0] ?? "") : "";
    return `${spanned}${FLAG_OPEN}${flag}${FLAG_CLOSE}`;
  }
  if (CHARACTER_TEMPLATES.has(name)) return CHARACTER_TEMPLATES.get(name);
  if (SILENT.has(name) || SILENT_PREFIXES.some((p) => name.startsWith(p))) return "";

  // Language and transliteration: the text, not the markup around it.
  if (["lang", "transliteration", "transl", "tlit", "translit", "transl."].includes(name))
    return args[args.length - 1] ?? "";
  if (name === "langx" || /^lang-[a-z-]+$/.test(name)) {
    const code = name === "langx" ? args[0] : name.slice(5);
    const text = name === "langx" ? (args[1] ?? "") : (args[0] ?? "");
    const label = named(params, "label");
    if (label === "none") return text;
    const language = label || LANGUAGE_NAMES[code?.toLowerCase()];
    return language ? `${language}: ${text}` : text;
  }
  // {{nihongo|English|kanji|romaji}} → "English (kanji, romaji)"
  if (name === "nihongo" || name === "nihongo foot") {
    const [en = "", kanji = "", romaji = ""] = params.map((p) => p.trim());
    const inner = [kanji, romaji].filter(Boolean).join(", ");
    return en ? (inner ? `${en} (${inner})` : en) : inner ? `(${inner})` : "";
  }
  if (name === "nihongo2") return args[0] ?? "";
  // {{nihongo3|English|kanji|romaji}} → "romaji (kanji, English)"
  if (name === "nihongo3") {
    const [en = "", kanji = "", romaji = ""] = params.map((p) => p.trim());
    const inner = [kanji, en].filter(Boolean).join(", ");
    return romaji ? (inner ? `${romaji} (${inner})` : romaji) : inner;
  }
  if (name === "zh" || name === "zh-full" || name === "chinese") {
    const parts = params.map((p) => p.split("=").slice(1).join("=").trim()).filter(Boolean);
    return parts.join("; ");
  }
  if (
    [
      "small",
      "smaller",
      "large",
      "big",
      "nowrap",
      "nobr",
      "em",
      "strong",
      "sic",
      "ill",
      "interlanguage link",
      "linktext",
      "sup",
      "sub",
      "sc",
      "smallcaps",
      "small caps",
      "lit",
      "literally",
      "gloss",
      "noitalic",
      "nowrap begin",
      "keypress",
      "var",
      "text",
      "plainlist",
      "flatlist",
      "ubl",
      "unbulleted list",
      "hlist",
      "abbr",
      "abbrlink",
      "tooltip",
      "visible anchor",
      "vanchor",
      "blockquote",
      "quote",
      "cquote",
      "quotation",
      "poemquote",
      "lime",
      "color",
      "colour",
      "font color",
      "highlight",
      "mark",
      "underline",
      "u",
      "strikethrough",
      "s",
    ].includes(name)
  ) {
    if (["plainlist", "flatlist", "ubl", "unbulleted list", "hlist"].includes(name))
      return args.join(", ");
    if (["blockquote", "quote", "cquote", "quotation", "poemquote"].includes(name))
      return named(params, "text") ?? named(params, "quote") ?? args[0] ?? "";
    if (name === "lit" || name === "literally") return `lit. '${args[0] ?? ""}'`;
    if (name === "gloss") return `'${args[0] ?? ""}'`;
    if (name === "color" || name === "colour" || name === "font color")
      return args[args.length - 1] ?? "";
    return args[0] ?? "";
  }
  if (name === "circa" || name === "c." || name === "ca.") return `c. ${args[0] ?? ""}`.trim();
  if (name === "as of") {
    const lc = named(params, "lc");
    return `${lc ? "as of" : "As of"} ${args.join(" ")}`.trim();
  }
  if (name === "convert" || name === "cvt") {
    // {{convert|5|km|mi}} → "5 km"; {{convert|1|-|2|km}} → "1–2 km"
    if (["-", "to", "and", "or", "–"].includes(args[1]))
      return `${args[0]}${args[1] === "-" || args[1] === "–" ? "–" : ` ${args[1]} `}${args[2]} ${args[3] ?? ""}`.trim();
    return `${args[0] ?? ""} ${args[1] ?? ""}`.trim();
  }
  if (name === "frac")
    return args.length === 3 ? `${args[0]} ${args[1]}/${args[2]}` : args.join("/");
  if (name === "year" || name === "start date" || name === "birth date" || name === "death date")
    return args.filter((a) => /^\d+$/.test(a)).join("-");
  if (name === "currency" || name === "money") return args.join(" ");
  if (/^(us\$|usd|jpy|¥|cny|inr|₹|eur|€|gbp|£)$/i.test(name))
    return `${name.toUpperCase()} ${args[0] ?? ""}`.trim();

  return UNKNOWN;
}

/** Replace innermost {{…}} until none remain (templates nest arbitrarily). */
function expandTemplates(s) {
  let prev;
  let guard = 0;
  do {
    prev = s;
    s = s.replace(/\{\{([^{}]*)\}\}/g, (_, body) => renderTemplate(body));
  } while (s !== prev && ++guard < 50);
  return s.replace(/\{\{|\}\}/g, ""); // unbalanced leftovers
}

/** File, image and category links render nothing in the prose. */
const MEDIA_OR_CATEGORY = /^\s*(file|image|media|category)\s*:/i;
/** Interwiki prefixes whose inline links display text (`[[wikt:grâces|grâces]]`). */
const INLINE_INTERWIKI =
  /^\s*(wikt|wiktionary|w|wikipedia|s|wikisource|q|wikiquote|b|wikibooks|n|wikinews|v|voy|wikivoyage|commons|c|species|d|wikidata|meta|m|mw|foundation)\s*:/i;
/** `[[fr:Paris]]` without a leading colon is a sidebar language link, not prose. */
const LANGUAGE_LINK = /^[a-z]{2,3}(-[a-z]+)*\s*:/i;

/** Replace innermost [[…]] until none remain. */
function expandLinks(s) {
  let prev;
  let guard = 0;
  do {
    prev = s;
    s = s.replace(/\[\[([^[\]]*)\]\]/g, (_, body) => {
      const inline = body.startsWith(":");
      const target = inline ? body.slice(1) : body;
      if (!inline && MEDIA_OR_CATEGORY.test(target)) return "";
      if (!inline && !INLINE_INTERWIKI.test(target) && LANGUAGE_LINK.test(target)) return "";
      const parts = splitParams(target);
      if (parts.length > 1) return parts.slice(1).join("|");
      // No label: the target without its interwiki/language prefix or #section.
      return parts[0]
        .replace(/^[a-z-]+\s*:(?=.)/i, (m) => (MEDIA_OR_CATEGORY.test(m) ? m : ""))
        .replace(/#.*$/, "");
    });
  } while (s !== prev && ++guard < 20);
  return s;
}

function stripTags(s) {
  return s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<ref\b[^>/]*\/>/gi, REF)
    .replace(/<ref\b[^>]*>[\s\S]*?<\/ref\s*>/gi, REF)
    .replace(
      /<(gallery|math|chem|timeline|score|graph|mapframe|maplink|templatedata|imagemap|syntaxhighlight|source|code|hiero|references|noinclude|ce)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      "",
    )
    .replace(/<references\b[^>]*\/>/gi, "")
    .replace(/<nowiki\s*\/>/gi, "")
    .replace(/<nowiki>([\s\S]*?)<\/nowiki>/gi, (_, t) =>
      t.replace(/\[/g, "&#91;").replace(/\{/g, "&#123;").replace(/\|/g, "&#124;"),
    )
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?[a-z][a-z0-9]*\b[^>]*>/gi, "");
}

/** Drop {| … |} tables, which nest. Line-based, like the parser. */
function dropTables(lines) {
  const out = [];
  let depth = 0;
  for (const line of lines) {
    const t = line.trimStart();
    if (t.startsWith("{|")) {
      depth++;
      continue;
    }
    if (depth > 0) {
      if (t.startsWith("|}")) depth--;
      continue;
    }
    out.push(line);
  }
  return out;
}

const HEADING = /^(={2,6})\s*(.+?)\s*\1\s*$/;

function tidy(text) {
  return decodeHtmlEntities(text)
    .replace(/'{2,5}/g, "")
    .replace(/\[(?:https?:)?\/\/\S+\s+([^\]]+)\]/g, "$1") // [http://x label] → label
    .replace(/\[(?:https?:)?\/\/\S+\]/g, "") // [http://x] → nothing
    .replace(/__[A-Z]+__/g, "")
    .replace(/[ \t ]+/g, " ")
    .replace(/\(\s*[,;]\s*/g, "(")
    .replace(/\s*[,;]\s*\)/g, ")")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([,.;:!?)])/g, "$1")
    .replace(/\(\s+/g, "(")
    .trim();
}

/**
 * Paragraphs of an article, each with its heading path and what was removed
 * from it: `refs` (footnote count), `flags` (maintenance tags), and
 * `unknownTemplates` (inline templates this renderer could not reproduce).
 */
export function wikitextParagraphs(raw, { xmlEscaped = false } = {}) {
  let s = xmlEscaped ? decodeXmlEntities(raw) : raw;
  s = stripTags(s);
  s = expandTemplates(s);
  s = expandLinks(s);

  const paragraphs = [];
  const path = [];
  let buffer = [];
  const flush = () => {
    if (!buffer.length) return;
    const joined = buffer.join(" ");
    buffer = [];
    const refs = joined.split(REF).length - 1;
    const flags = [...joined.matchAll(new RegExp(`${FLAG_OPEN}([a-z-]+)${FLAG_CLOSE}`, "g"))].map(
      (m) => m[1],
    );
    const unknownTemplates = joined.split(UNKNOWN).length - 1;
    const text = tidy(
      joined
        .replaceAll(REF, "")
        .replace(new RegExp(`${FLAG_OPEN}[a-z-]+${FLAG_CLOSE}`, "g"), "")
        .replaceAll(UNKNOWN, ""),
    );
    if (text)
      paragraphs.push({
        headingPath: path.filter(Boolean),
        text,
        refs,
        flags: [...new Set(flags)],
        unknownTemplates,
      });
  };

  for (const line of dropTables(s.split("\n"))) {
    const trimmed = line.trim();
    const heading = trimmed.match(HEADING);
    if (heading) {
      flush();
      const depth = heading[1].length - 2;
      path.length = depth;
      path[depth] = tidy(heading[2].replaceAll(REF, "").replaceAll(UNKNOWN, ""));
      continue;
    }
    if (!trimmed || /^-{4,}$/.test(trimmed)) {
      flush();
      continue;
    }
    if (/^[*#:;]/.test(trimmed)) {
      // List items and indented lines are their own paragraphs, as in TextExtracts.
      flush();
      buffer.push(trimmed.replace(/^[*#:;]+\s*/, ""));
      flush();
      continue;
    }
    // Leftover table/template syntax lines (orphaned "|" rows, magic words).
    if (/^[|!]/.test(trimmed)) continue;
    buffer.push(trimmed);
  }
  flush();
  return paragraphs;
}

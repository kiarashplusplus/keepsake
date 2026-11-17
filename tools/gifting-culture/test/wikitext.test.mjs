/**
 * The dump path renders wikitext itself. Each case here is a construct taken
 * from a real gifting passage, rendered the way MediaWiki renders it
 * (checked against TextExtracts for the same revision; see fidelity.mjs).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { wikitextParagraphs } from "../lib/wikitext.mjs";

const one = (wikitext) => wikitextParagraphs(wikitext)[0];

test("nihongo templates render as MediaWiki does", () => {
  assert.equal(
    one("The latter is called {{nihongo3|obligation chocolate|義理チョコ|giri-choko}}.").text,
    "The latter is called giri-choko (義理チョコ, obligation chocolate).",
  );
  assert.equal(
    one("money called ''kōden'' {{nihongo||[[:ja:香典|香典]]}} in envelopes").text,
    "money called kōden (香典) in envelopes",
  );
  assert.equal(
    one("{{nihongo|Bowing|お辞儀|o-jigi}} is important.").text,
    "Bowing (お辞儀, o-jigi) is important.",
  );
});

test("language, transliteration and gloss templates keep their text", () => {
  assert.equal(
    one("'''Xenia''' ({{langx|grc|ξενία}}) is a concept.").text,
    "Xenia (Ancient Greek: ξενία) is a concept.",
  );
  assert.equal(
    one("derived from {{tlit|grc|[[Xenos (Greek)|xenos]]}} {{gloss|stranger}}.").text,
    "derived from xenos 'stranger'.",
  );
  assert.equal(
    one("terms like [[wikt:grâces|grâces]] and {{lang|fr|bonté}}.").text,
    "terms like grâces and bonté.",
  );
});

test("links: label kept, files/categories/language links gone", () => {
  assert.equal(
    one(
      "[[fr:Paris]][[Category:Gifts]][[File:A.jpg|thumb|A caption with [[a link]]]]Gifts in [[New York City|NYC]] and [[Tokyo]]s.",
    ).text,
    "Gifts in NYC and Tokyos.",
  );
});

test("references are counted, not rendered; maintenance tags become flags", () => {
  const p = one(
    'Gifts are opened later.<ref name="a">{{cite book|title=Gift}}</ref> Money is given.<ref name="a"/>{{citation needed|date=May 2020}} It is {{dubious}} common.',
  );
  assert.equal(p.text, "Gifts are opened later. Money is given. It is common.");
  assert.equal(p.refs, 2);
  assert.deepEqual(p.flags.sort(), ["citation-needed", "dubious"]);
});

test("an unknown inline template is removed and counted, never silently", () => {
  const p = one("The town is {{some unknown template|5}} from the coast, and gifts are exchanged.");
  assert.equal(p.unknownTemplates, 1);
  assert.equal(p.text, "The town is from the coast, and gifts are exchanged.");
});

test("infoboxes, tables, comments and nowiki", () => {
  const paragraphs = wikitextParagraphs(
    [
      "{{Infobox settlement\n| name = Examplia\n| population = {{formatnum:1000}}\n}}",
      "<!-- hidden note about gifts -->Examplia is a city.",
      "",
      '{| class="wikitable"\n|-\n| gifts || cell\n|}',
      "Visitors bring <nowiki>[[gifts]]</nowiki>.",
    ].join("\n"),
  );
  assert.deepEqual(
    paragraphs.map((p) => p.text),
    ["Examplia is a city.", "Visitors bring [[gifts]]."],
  );
});

test("headings, nesting and list items", () => {
  const paragraphs = wikitextParagraphs(
    "Lead.\n== Customs ==\n=== Gifts ===\nOne line\ncontinues here.\n* A list item about gifts\n== See also ==\n* [[Gift]]",
  );
  assert.deepEqual(
    paragraphs.map((p) => [p.headingPath.join(" > "), p.text]),
    [
      ["", "Lead."],
      ["Customs > Gifts", "One line continues here."],
      ["Customs > Gifts", "A list item about gifts"],
      ["See also", "Gift"],
    ],
  );
});

test("convert, circa and character templates", () => {
  assert.equal(
    one("ruins are {{convert|3|km}} away, built {{circa|1900}}{{snd}}gifts").text,
    "ruins are 3 km away, built c. 1900 – gifts",
  );
});

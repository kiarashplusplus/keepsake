#!/usr/bin/env node
/**
 * How faithful is the dump path's text? Compares `lib/wikitext.mjs`'s
 * rendering of articles from the dump with MediaWiki's own plain-text
 * rendering (TextExtracts) of the same articles, taken from an API-path
 * cache directory.
 *
 *   node tools/gifting-culture/fidelity.mjs --cache out/.cache/http --index index.txt.bz2
 *
 * For every gifting passage the API path would extract (articles taken as
 * "about the place", so no mention filter), it finds the best-matching dump
 * paragraph by word-set overlap (Jaccard) and reports the distribution.
 * Pairs at the same revision measure the renderer alone. Pairs at different
 * revisions also measure edits since the dump, so they are reported apart.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { DUMP_BASE, DUMP_FILE, fetchPagesAt, readIndex } from "./lib/dump.mjs";
import { extractPassages } from "./lib/extract.mjs";
import { wikitextParagraphs } from "./lib/wikitext.mjs";
import { DEFAULT_USER_AGENT } from "./lib/http.mjs";

const { values } = parseArgs({
  options: {
    cache: { type: "string" },
    index: { type: "string" },
    worst: { type: "string", default: "8" },
  },
});
if (!values.cache || !values.index) {
  console.error("usage: fidelity.mjs --cache <api cache dir> --index <multistream index .bz2>");
  process.exit(2);
}

const words = (s) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
function jaccard(a, b) {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

const api = new Map();
for (const file of readdirSync(values.cache)) {
  const entry = JSON.parse(readFileSync(path.join(values.cache, file), "utf8"));
  const page = entry.body?.query?.pages?.[0];
  if (page?.extract)
    api.set(page.title, { revisionId: page.revisions?.[0]?.revid, text: page.extract });
}
console.error(`${api.size} TextExtracts articles in the cache; reading the dump index…`);

const { offsets, found } = await readIndex(values.index, new Set(api.keys()));
const userAgent = process.env.WIKIMEDIA_USER_AGENT || DEFAULT_USER_AGENT;
const url = `${DUMP_BASE}/${DUMP_FILE}`;

const byOffset = new Map();
for (const [title, { offset }] of found)
  byOffset.set(offset, [...(byOffset.get(offset) ?? []), title]);

const results = [];
for (const [offset, titles] of byOffset) {
  const pages = await fetchPagesAt({ url, offset, offsets, userAgent });
  for (const title of titles) {
    const dumpPage = pages.find((p) => p.title === title);
    const ref = api.get(title);
    if (!dumpPage || dumpPage.redirect) continue;
    const dumpParas = wikitextParagraphs(dumpPage.text).map((p) => ({
      ...p,
      words: words(p.text),
    }));
    const passages = extractPassages({
      title,
      text: ref.text,
      subjectNames: [],
      requiresMention: false,
    });
    for (const passage of passages) {
      const w = words(passage.text);
      let best = { score: 0 };
      for (const d of dumpParas) {
        const score = jaccard(w, d.words);
        if (score > best.score) best = { score, dump: d };
      }
      results.push({
        title,
        sameRevision: ref.revisionId === dumpPage.revisionId,
        score: best.score,
        api: passage.text,
        dump: best.dump?.text ?? "",
        unknownTemplates: best.dump?.unknownTemplates ?? 0,
      });
    }
  }
}

function summarise(label, rows) {
  if (!rows.length) return console.log(`${label}: none`);
  const at = (t) => rows.filter((r) => r.score >= t).length;
  const pct = (n) => `${((100 * n) / rows.length).toFixed(1)}%`;
  console.log(
    `${label}: ${rows.length} passages — ≥0.95: ${pct(at(0.95))}, ≥0.90: ${pct(at(0.9))}, ≥0.80: ${pct(at(0.8))}, ` +
      `<0.80: ${pct(rows.length - at(0.8))}; flagged unknownTemplates>0: ${pct(rows.filter((r) => r.unknownTemplates > 0).length)}`,
  );
}
const articles = new Set(results.map((r) => r.title));
console.log(
  `compared ${articles.size} articles (${[...articles].filter((t) => results.find((r) => r.title === t)?.sameRevision).length} at the same revision)`,
);
summarise(
  "same revision ",
  results.filter((r) => r.sameRevision),
);
summarise(
  "newer revision",
  results.filter((r) => !r.sameRevision),
);
console.log("\nworst same-revision matches:");
for (const r of results
  .filter((x) => x.sameRevision)
  .sort((a, b) => a.score - b.score)
  .slice(0, Number(values.worst))) {
  console.log(
    `\n[${r.score.toFixed(2)}] ${r.title}\n  API : ${r.api.slice(0, 300)}\n  DUMP: ${r.dump.slice(0, 300)}`,
  );
}

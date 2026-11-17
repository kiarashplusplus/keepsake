/**
 * The gifting corpus: every paragraph in English Wikipedia that is about
 * gift-giving, from one full pass over the dump.
 *
 * This is the rate-limit-free path, and it is also the higher-recall one.
 * The API path can only find what a search query happens to rank; the scan
 * reads every article, so a paragraph about New Year customs in Kraków is
 * found because it says "Kraków" and "gifts" in one sentence, whatever its
 * article is called.
 *
 * Layout under `<out>/corpus/`:
 *
 *   manifest.json   which dump (URL, size, Last-Modified) and how it was cut
 *   parts/NNNN.jsonl   one gifting paragraph per line, one file per chunk
 *   parts/NNNN.json    that chunk's counts; its presence marks the chunk done
 *
 * A chunk is written to a temp file and renamed only when its range has been
 * read and decompressed to the end, so a killed scan resumes at the first
 * unfinished chunk and never keeps a truncated one. A manifest from a
 * different dump stops the run instead of mixing two snapshots.
 */
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  DUMP_BASE,
  DUMP_FILE,
  INDEX_FILE,
  MAX_DUMP_CONNECTIONS,
  planChunks,
  readIndex,
} from "./dump.mjs";
import { relevance } from "./extract.mjs";
import { GIFT_TERMS, compile } from "./lexicon.mjs";
import { wikitextParagraphs } from "./wikitext.mjs";

/**
 * Pre-filters, cheapest first. The precise, Unicode-aware lexicon regex costs
 * ~50 ms per MB of wikitext, which over a 110 GB dump is hours of CPU, so it
 * only runs on pages that pass a plain substring-style test, and only after
 * references are stripped: "Gift" in a citation's title is the most common
 * reason a page passes the first test and has nothing to say.
 */
const ROUGH =
  /gift|presents|(?:christmas|birthday|wedding|holiday|new year'?s?|housewarming|farewell) present|souvenir|keepsake|heirloom|hand-me-down|wedding favou?r|red (?:envelope|packet)|hongbao|hóngbāo|lai see|lucky money|ang ?pao|lì xì|li xi|sebaetdon|otoshidama|eidi|shagun|k[oō]den|omiyage|pasalubong|balikbayan|ch[uū]gen|seibo|potlatch|secret santa|christmas stocking|julklapp|m[aă]r[tț]i[sș]or|alms|zakat|sadaqah|tzedakah/i;
const PRECISE = new RegExp(compile(GIFT_TERMS).source, "iu");
const REFS =
  /<ref\b[^>/]*\/>|<ref\b[^>]*>[\s\S]*?<\/ref\s*>|\{\{\s*(?:cite|citation)\b[^{}]*\}\}/gi;

export function mightBeAboutGifts(page) {
  if (ROUGH.test(page.title) && PRECISE.test(page.title)) return true;
  if (!ROUGH.test(page.text)) return false;
  const prose = page.text.replace(REFS, "");
  return ROUGH.test(prose) && PRECISE.test(prose);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.trim()}`)),
    );
  });
}

export async function dumpHead(url, userAgent) {
  const headers = await run("curl", ["-sSI", "--fail", "-A", userAgent, url]);
  const size = Number(headers.match(/content-length:\s*(\d+)/i)?.[1]);
  const lastModified = headers.match(/last-modified:\s*([^\r\n]+)/i)?.[1] ?? null;
  if (!Number.isFinite(size)) throw new Error(`no Content-Length for ${url}`);
  return { url, size, lastModified };
}

/** The gifting paragraphs of one page, as corpus rows. Pure; exported for tests. */
export function pageRows(page) {
  if (page.ns !== 0 || page.redirect) return [];
  if (!mightBeAboutGifts(page)) return [];
  const rows = [];
  for (const p of wikitextParagraphs(page.text)) {
    if (!relevance(page.title, p.headingPath, p.text)) continue;
    rows.push({
      title: page.title,
      pageId: page.pageId,
      revisionId: page.revisionId,
      revisionTimestamp: page.revisionTimestamp,
      headingPath: p.headingPath,
      text: p.text,
      refs: p.refs,
      flags: p.flags,
      unknownTemplates: p.unknownTemplates,
    });
  }
  return rows;
}

export async function buildCorpus({
  out,
  userAgent,
  chunkCount = 128,
  concurrency = MAX_DUMP_CONNECTIONS,
  maxChunks = Infinity,
  indexPath,
  log = () => {},
}) {
  const dir = path.join(out, "corpus");
  const parts = path.join(dir, "parts");
  mkdirSync(parts, { recursive: true });
  const url = `${DUMP_BASE}/${DUMP_FILE}`;
  if (concurrency > MAX_DUMP_CONNECTIONS) {
    throw new Error(
      `dumps.wikimedia.org asks for at most ${MAX_DUMP_CONNECTIONS} connections; got ${concurrency}`,
    );
  }

  const head = await dumpHead(url, userAgent);
  const manifestPath = path.join(dir, "manifest.json");
  if (existsSync(manifestPath)) {
    const previous = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (previous.dump.size !== head.size || previous.dump.lastModified !== head.lastModified) {
      throw new Error(
        `the corpus in ${dir} was built from a different dump (${previous.dump.lastModified}) than the current one ` +
          `(${head.lastModified}). Move it aside to start a fresh scan; parts from two snapshots are never mixed.`,
      );
    }
    if (previous.chunkCount !== chunkCount) {
      throw new Error(
        `the corpus was cut into ${previous.chunkCount} chunks; pass --chunks ${previous.chunkCount} to resume it`,
      );
    }
  }

  indexPath ??= path.join(out, "dump", INDEX_FILE);
  if (!existsSync(indexPath)) {
    log(`  downloading the dump index (~290 MB) to ${indexPath}`);
    mkdirSync(path.dirname(indexPath), { recursive: true });
    await run("curl", [
      "-sS",
      "--fail",
      "--retry",
      "5",
      "-A",
      userAgent,
      "-o",
      `${indexPath}.part`,
      `${DUMP_BASE}/${INDEX_FILE}`,
    ]);
    renameSync(`${indexPath}.part`, indexPath);
  }
  log("  reading the index (~40 s)");
  const { offsets } = await readIndex(indexPath);
  const chunks = planChunks(offsets, head.size, chunkCount);
  const plan = chunks.map((c) => [c.start, c.end]);
  if (existsSync(manifestPath)) {
    // Same snapshot and same count can still mean a different cut (the
    // planner changed): parts from two cuts would overlap or leave gaps.
    const previous = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (JSON.stringify(previous.plan) !== JSON.stringify(plan)) {
      throw new Error(
        `the corpus in ${dir} was cut differently; move it aside to start a fresh scan`,
      );
    }
  } else {
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ dump: head, chunkCount, streams: offsets.length, plan, createdAt: new Date().toISOString() }, null, 2)}\n`,
    );
  }

  const name = (c) => String(c.index).padStart(4, "0");
  const pending = chunks.filter((c) => !existsSync(path.join(parts, `${name(c)}.json`)));
  const todo = pending.slice(0, maxChunks);
  log(
    `  ${chunks.length - pending.length} of ${chunks.length} chunks already done; scanning ${todo.length}, ${concurrency} at a time`,
  );

  let next = 0;
  let finished = 0;
  const started = Date.now();
  async function worker() {
    while (next < todo.length) {
      const chunk = todo[next++];
      const base = path.join(parts, name(chunk));
      const counts = await new Promise((resolve, reject) => {
        const thread = new Worker(new URL("./corpus-worker.mjs", import.meta.url), {
          workerData: {
            url,
            chunk,
            userAgent,
            tmp: `${base}.jsonl.${process.pid}.tmp`,
            final: `${base}.jsonl`,
          },
        });
        thread.once("message", resolve);
        thread.once("error", reject);
        thread.once(
          "exit",
          (code) => code !== 0 && reject(new Error(`chunk ${name(chunk)} worker exited ${code}`)),
        );
      });
      writeFileSync(`${base}.json`, `${JSON.stringify({ ...chunk, ...counts })}\n`);
      finished++;
      const rate = ((Date.now() - started) / finished / 1000).toFixed(0);
      log(
        `  chunk ${name(chunk)} done: ${counts.articles} articles, ${counts.rows} gifting paragraphs (${finished}/${todo.length}, ~${rate}s/chunk)`,
      );
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  return corpusStatus(out);
}

export function corpusStatus(out) {
  const dir = path.join(out, "corpus");
  const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const done = readdirSync(path.join(dir, "parts")).filter((f) => /^\d{4}\.json$/.test(f));
  const totals = { articles: 0, articlesWithRows: 0, rows: 0 };
  for (const f of done) {
    const c = JSON.parse(readFileSync(path.join(dir, "parts", f), "utf8"));
    for (const k of Object.keys(totals)) totals[k] += c[k];
  }
  return {
    manifest,
    chunksDone: done.length,
    complete: done.length === manifest.plan.length,
    ...totals,
  };
}

/** Every corpus row, grouped by article title. */
export function loadCorpus(out) {
  const status = corpusStatus(out);
  const byTitle = new Map();
  const parts = path.join(out, "corpus", "parts");
  for (const f of readdirSync(parts)
    .filter((x) => x.endsWith(".jsonl"))
    .sort()) {
    for (const line of readFileSync(path.join(parts, f), "utf8").split("\n")) {
      if (!line) continue;
      const row = JSON.parse(line);
      let article = byTitle.get(row.title);
      if (!article) {
        article = {
          title: row.title,
          pageId: row.pageId,
          revisionId: row.revisionId,
          revisionTimestamp: row.revisionTimestamp,
          paragraphs: [],
        };
        byTitle.set(row.title, article);
      }
      article.paragraphs.push({
        headingPath: row.headingPath,
        text: row.text,
        refs: row.refs,
        flags: row.flags,
        unknownTemplates: row.unknownTemplates,
      });
    }
  }
  return { status, byTitle };
}

/**
 * The English Wikipedia dump: the rate-limit-free way to read a lot of
 * Wikipedia.
 *
 * `pages-articles-multistream.xml.bz2` (~27 GB, refreshed about twice a
 * month) is a concatenation of independent bzip2 streams of ~100 pages each,
 * and its companion index maps every title to the byte offset of the stream
 * holding it. That allows two things:
 *
 * - **Random access**: one HTTP Range request fetches the ~100–400 KB stream
 *   that contains a page (`fetchPagesAt`).
 * - **A full scan in parallel**: stream boundaries split the file into chunks
 *   that decompress independently (`planChunks`, `scanChunk`).
 *
 * dumps.wikimedia.org is not behind the API gateway's rate limits. It asks
 * clients to keep to **two concurrent connections**, which is the default
 * here. Decompression shells out to `bzcat`, as tools/geodata shells out to
 * `unzip`: no npm dependency.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export const DUMP_BASE = "https://dumps.wikimedia.org/enwiki/latest";
export const DUMP_FILE = "enwiki-latest-pages-articles-multistream.xml.bz2";
export const INDEX_FILE = "enwiki-latest-pages-articles-multistream-index.txt.bz2";
export const MAX_DUMP_CONNECTIONS = 2;

function decodeXml(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Parse one `<page>…</page>` element. The dump's XML is machine-written and
 * regular, so targeted regexes are enough (and far faster than a DOM).
 */
export function parsePage(xml) {
  const title = xml.match(/<title>([^<]*)<\/title>/)?.[1];
  const ns = Number(xml.match(/<ns>(\d+)<\/ns>/)?.[1]);
  const id = Number(xml.match(/<id>(\d+)<\/id>/)?.[1]);
  if (title === undefined || !Number.isFinite(id)) return null;
  const redirect = xml.match(/<redirect title="([^"]*)"/)?.[1];
  const revision = xml.match(/<revision>\s*<id>(\d+)<\/id>/)?.[1];
  const timestamp = xml.match(/<timestamp>([^<]+)<\/timestamp>/)?.[1];
  const text = xml.match(/<text\b[^>]*>([\s\S]*?)<\/text>/)?.[1] ?? "";
  return {
    title: decodeXml(title),
    ns,
    pageId: id,
    redirect: redirect === undefined ? null : decodeXml(redirect),
    revisionId: revision ? Number(revision) : null,
    revisionTimestamp: timestamp ?? null,
    text: decodeXml(text),
  };
}

/** Async-iterate pages from a stream of decompressed XML text. */
export async function* pagesFromText(chunks) {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("</page>")) !== -1) {
      const start = buffer.lastIndexOf("<page>", end);
      const page = start === -1 ? null : parsePage(buffer.slice(start, end));
      buffer = buffer.slice(end + 7);
      if (page) yield page;
    }
  }
}

/**
 * `curl -r start-end url | bzcat`, as a text stream. Rejects loudly if either
 * process fails; a truncated range is the one error a parser cannot detect
 * by itself, so the exit codes are the check.
 */
export function rangeText({ url, start, end, userAgent }) {
  const range = end == null ? `${start}-` : `${start}-${end}`;
  const curl = spawn(
    "curl",
    ["-sS", "--fail", "--retry", "5", "--retry-all-errors", "-A", userAgent, "-r", range, url],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const bzcat = spawn("bzcat", [], { stdio: ["pipe", "pipe", "pipe"] });
  curl.stdout.pipe(bzcat.stdin);
  bzcat.stdout.setEncoding("utf8");
  let curlErr = "";
  let bzErr = "";
  curl.stderr.on("data", (d) => (curlErr += d));
  bzcat.stderr.on("data", (d) => (bzErr += d));
  const exits = Promise.all([
    new Promise((resolve) => curl.on("close", resolve)),
    new Promise((resolve) => bzcat.on("close", resolve)),
  ]).then(([curlCode, bzCode]) => {
    if (curlCode !== 0) throw new Error(`curl ${range} exited ${curlCode}: ${curlErr.trim()}`);
    if (bzCode !== 0) throw new Error(`bzcat on ${range} exited ${bzCode}: ${bzErr.trim()}`);
  });
  exits.catch(() => {}); // surfaced by `done`, not as an unhandled rejection
  return { stream: bzcat.stdout, done: exits, kill: () => (curl.kill(), bzcat.kill()) };
}

/**
 * Read the multistream index (`offset:pageId:title` per line, bzip2) once.
 * Returns the sorted distinct stream offsets, and for every title in
 * `wanted` the offset of its stream. Takes ~40 s for 26 M lines.
 */
export async function readIndex(indexPath, wanted = new Set()) {
  const bz = spawn("bzcat", [indexPath], { stdio: ["ignore", "pipe", "inherit"] });
  const lines = createInterface({ input: bz.stdout, crlfDelay: Infinity });
  const offsets = [];
  const found = new Map();
  let last = -1;
  for await (const line of lines) {
    const a = line.indexOf(":");
    const b = line.indexOf(":", a + 1);
    const offset = Number(line.slice(0, a));
    if (offset !== last) {
      offsets.push(offset);
      last = offset;
    }
    if (wanted.size) {
      const title = line.slice(b + 1);
      if (wanted.has(title)) found.set(title, { offset, pageId: Number(line.slice(a + 1, b)) });
    }
  }
  return { offsets, found };
}

/** The pages in the stream starting at `offset`, via one Range request. */
export async function fetchPagesAt({ url, offset, offsets, userAgent }) {
  const next = offsets.find((o) => o > offset);
  const { stream, done } = rangeText({
    url,
    start: offset,
    end: next ? next - 1 : null,
    userAgent,
  });
  const pages = [];
  for await (const page of pagesFromText(stream)) pages.push(page);
  await done;
  return pages;
}

/**
 * Split the file into ~`count` byte ranges of similar size that begin and end
 * on stream boundaries, so each decompresses on its own. Balanced by bytes,
 * not by stream count: early streams hold the oldest, longest articles, and
 * cutting by count made the first chunk 2.7× the third. The first chunk
 * starts at the first indexed stream; the bytes before it are the site header.
 */
export function planChunks(offsets, fileSize, count) {
  const first = offsets[0];
  const target = (fileSize - first) / count;
  const chunks = [];
  let start = first;
  let streams = 0;
  for (let i = 1; i <= offsets.length; i++) {
    streams++;
    const boundary = i < offsets.length ? offsets[i] : fileSize;
    if (boundary - start >= target || i === offsets.length) {
      chunks.push({ index: chunks.length, start, end: boundary - 1, streams });
      start = boundary;
      streams = 0;
    }
  }
  return chunks;
}

/** Stream every page of one chunk to `onPage`. */
export async function scanChunk({ url, chunk, userAgent, onPage }) {
  const { stream, done, kill } = rangeText({ url, start: chunk.start, end: chunk.end, userAgent });
  try {
    for await (const page of pagesFromText(stream)) await onPage(page);
  } catch (error) {
    kill();
    throw error;
  }
  await done;
}

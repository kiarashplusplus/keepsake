/**
 * Scans one dump chunk on its own thread. Two chunks in one thread were
 * CPU-bound on a single core (measured: 9.5 CPU-minutes per 8 wall-minutes);
 * a thread each lets the parse and the render use the cores bzcat leaves.
 */
import { createWriteStream, renameSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { scanChunk } from "./dump.mjs";
import { pageRows } from "./corpus.mjs";

const { url, chunk, userAgent, tmp, final } = workerData;
const stream = createWriteStream(tmp);
const counts = { pages: 0, articles: 0, articlesWithRows: 0, rows: 0 };
const t0 = Date.now();

await scanChunk({
  url,
  chunk,
  userAgent,
  onPage: (page) => {
    counts.pages++;
    if (page.ns === 0 && !page.redirect) counts.articles++;
    const rows = pageRows(page);
    if (rows.length) counts.articlesWithRows++;
    let ok = true;
    for (const row of rows) {
      counts.rows++;
      ok = stream.write(`${JSON.stringify(row)}\n`) && ok;
    }
    if (!ok) return new Promise((resolve) => stream.once("drain", resolve));
  },
});
await new Promise((resolve, reject) => stream.end((err) => (err ? reject(err) : resolve())));
renameSync(tmp, final);
parentPort.postMessage({ ...counts, ms: Date.now() - t0 });

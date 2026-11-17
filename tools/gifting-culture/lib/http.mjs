/**
 * A deliberately slow, deliberately stubborn HTTP client for Wikimedia.
 *
 * - **Serial.** One request in flight, at least `minIntervalMs` apart.
 *   Wikimedia's API etiquette asks for exactly this, and agent containers
 *   share an egress IP that Wikimedia already rate-limits: during the first
 *   run of this tool, roughly two requests in three came back `429` before
 *   any backoff existed.
 * - **Backs off exponentially** on 429/5xx, network errors, timeouts and
 *   MediaWiki's `maxlag` error, with `Retry-After` as a *floor* rather than
 *   the answer: Wikimedia's edge limiter often says "1" and then refuses
 *   again a second later, and obeying it literally just kept it closed.
 *   Gives up loudly after `maxRetries`.
 * - **Times out** each request after `timeoutMs`. The first live run hung
 *   for minutes on one response that never arrived.
 * - **Caches every successful body on disk**, keyed by URL, so a run that
 *   dies at city 400 resumes at city 400 and a re-run costs nothing. Pass
 *   `refresh: true` to ignore the cache (the new body is still written).
 *
 * The cache holds response bodies only; every passage the pipeline emits
 * carries the Wikipedia revision id it came from, so cached data is never
 * ambiguous about which version of an article it reflects.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";

export const DEFAULT_USER_AGENT =
  "gifting-culture-pipeline/0.1 (Node.js; set WIKIMEDIA_USER_AGENT)";

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpError extends Error {
  constructor(message, { status, url } = {}) {
    super(message);
    this.status = status;
    this.url = url;
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(header) {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export function createClient({
  userAgent = DEFAULT_USER_AGENT,
  cacheDir,
  minIntervalMs = 500,
  maxRetries = 10,
  maxBackoffMs = 120_000,
  timeoutMs = 90_000,
  refresh = false,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  now = Date.now,
  log = () => {},
} = {}) {
  if (cacheDir) mkdirSync(cacheDir, { recursive: true });
  const stats = { requests: 0, cacheHits: 0, retries: 0 };
  let queue = Promise.resolve();
  let lastRequestAt = -Infinity;

  const cachePath = (key) =>
    path.join(cacheDir, `${createHash("sha256").update(key).digest("hex")}.json`);

  function readCache(key) {
    if (!cacheDir || refresh) return undefined;
    try {
      return JSON.parse(readFileSync(cachePath(key), "utf8")).body;
    } catch {
      return undefined;
    }
  }

  function writeCache(key, body) {
    if (!cacheDir) return;
    const file = cachePath(key);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ key, fetchedAt: new Date(now()).toISOString(), body }));
    renameSync(tmp, file); // atomic: a killed run never leaves a half-written entry
  }

  async function attempt(url, headers, retries) {
    for (let tryNo = 0; ; tryNo++) {
      const wait = lastRequestAt + minIntervalMs - now();
      if (wait > 0) await sleep(wait);
      lastRequestAt = now();
      stats.requests++;

      let response;
      let text;
      let failure;
      try {
        // The timeout covers the body as well as the headers: the signal
        // stays live until `text()` settles.
        response = await fetchImpl(url, {
          headers: { "User-Agent": userAgent, ...headers },
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await response.text();
      } catch (error) {
        failure =
          error.name === "TimeoutError"
            ? `timed out after ${timeoutMs} ms`
            : `network error: ${error.message}`;
      }

      let body;
      if (text !== undefined) {
        if (response.ok) {
          try {
            body = JSON.parse(text);
          } catch {
            throw new HttpError(`non-JSON body from ${url}: ${text.slice(0, 200)}`, {
              status: response.status,
              url,
            });
          }
          // MediaWiki reports replication lag as an API error with HTTP 200.
          if (body?.error?.code === "maxlag") failure = "maxlag";
          else if (body?.error) {
            throw new HttpError(`API error ${body.error.code}: ${body.error.info}`, {
              status: response.status,
              url,
            });
          } else return body;
        } else if (RETRYABLE.has(response.status)) {
          failure = `HTTP ${response.status}`;
        } else {
          throw new HttpError(`HTTP ${response.status} from ${url}: ${text.slice(0, 200)}`, {
            status: response.status,
            url,
          });
        }
      }

      if (tryNo >= retries) {
        throw new HttpError(`gave up after ${tryNo + 1} attempts (${failure}): ${url}`, {
          status: response?.status,
          url,
        });
      }
      const hinted = retryAfterMs(response?.headers?.get?.("retry-after")) ?? 0;
      const backoff =
        Math.min(maxBackoffMs, Math.max(hinted, 1000 * 2 ** tryNo)) +
        Math.floor(Math.random() * 250);
      stats.retries++;
      log(`  retry ${tryNo + 1}/${retries} in ${Math.round(backoff / 1000)}s (${failure})`);
      await sleep(backoff);
    }
  }

  /**
   * GET a JSON document. `key` defaults to the URL; requests are queued so
   * concurrent callers still hit the network one at a time. `retries`
   * overrides `maxRetries` for calls where repeating is pointless (a SPARQL
   * query that timed out at 60 s will time out again).
   */
  function getJson(url, { headers = {}, key = url, retries = maxRetries } = {}) {
    const cached = readCache(key);
    if (cached !== undefined) {
      stats.cacheHits++;
      return Promise.resolve(cached);
    }
    const run = queue.then(async () => {
      const body = await attempt(url, headers, retries);
      writeCache(key, body);
      return body;
    });
    queue = run.catch(() => {});
    return run;
  }

  return { getJson, stats };
}

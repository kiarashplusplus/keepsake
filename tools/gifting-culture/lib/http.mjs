/**
 * A patient, well-identified HTTP client for Wikimedia.
 *
 * Wikimedia rate-limits its APIs **per client identity, per minute**
 * (https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits, 2026):
 *
 *   unidentified (no contact in the User-Agent)   10 req/min — shared by every
 *                                                 client on the same IP
 *   User-Agent with contact info                  200 req/min
 *   authenticated, new account                    200 req/min
 *   authenticated, established editor             2,000 req/min
 *   bot-flagged account / Toolforge               exempt
 *
 * The first version of this tool sent a generic User-Agent, so it sat in the
 * 10-a-minute bucket alongside every other agent container on its egress IP,
 * and most requests came back 429. The answer is not cleverer retrying. It
 * is to (1) identify, (2) authenticate when credentials exist (`auth`), and
 * (3) **pace** requests below the budget so 429s are the exception:
 *
 * - **Paced.** Requests to the rate-limited hosts are spaced at
 *   60 000 / `requestsPerMinute` ms. A 429 halves the pace, and each success
 *   wins a little back (AIMD), so a budget lower than configured is found
 *   rather than hammered. The Wikidata Query Service is not under these limits
 *   and is only kept serial.
 * - **Serial.** One request in flight. The policy asks for three or fewer.
 * - **Backs off** on 429/5xx, network errors, timeouts and `maxlag`,
 *   exponentially, with `Retry-After` as a floor. The edge limiter often says
 *   "1" and refuses again a second later. Gives up loudly after `maxRetries`.
 * - **Authenticates** via `auth.headers()` on Wikimedia API hosts only, and
 *   calls `auth.invalidate()` and retries once on a 401 (expired token).
 * - **Keeps cookies** that Wikimedia hosts set and returns them. The policy
 *   says owner-only OAuth tokens count as unauthenticated *unless* the
 *   client returns the cookies the server sets on the first request.
 * - **Times out** each request after `timeoutMs`.
 * - **Caches every successful body on disk**, keyed by `key` (default: the
 *   URL). `cache: false` skips the cache for one call (revision lookups,
 *   which must be fresh). `refresh: true` skips cache reads for the run.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";

/**
 * Compliant by default: names the tool and its operator. Kiarash chose the
 * project site as the contact (2026-11-17). Override with
 * WIKIMEDIA_USER_AGENT to run it as someone else.
 */
export const DEFAULT_USER_AGENT = "KeepsakeGiftingCulture/0.2 (https://keepsake.ing) Node.js";

/** Hosts under the per-identity API limits; they also get auth and cookies. */
const LIMITED_HOST = /(^|\.)(wikipedia|wikidata|wikimedia|mediawiki|wiktionary)\.org$/;
/** The Wikidata Query Service has separate limits and gets no credentials. */
const UNMETERED_HOSTS = new Set(["query.wikidata.org"]);

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Wikimedia's User-Agent policy: a client name plus a way to reach its
 * operator, as a URL or an email address. Without one, a client is
 * "unidentified" and gets 10 requests a minute.
 */
export function isCompliantUserAgent(ua) {
  return /https?:\/\/[^\s;)]+\.[^\s;)]+/.test(ua) || /[^\s@;()]+@[^\s@;()]+\.[a-z]{2,}/i.test(ua);
}

/** Pace that stays under each tier's published limit with headroom. */
export function defaultRequestsPerMinute({ userAgent, authenticated }) {
  if (authenticated) return 150; // new accounts get 200; established editors can pass --rpm up to ~1500
  return isCompliantUserAgent(userAgent) ? 150 : 8;
}

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

/**
 * The minimum cookie jar: name=value per domain, sent to that domain and its
 * subdomains. Expiry and paths are ignored, which is fine for one run.
 */
export function createCookieJar() {
  const byDomain = new Map(); // ".wikipedia.org" → Map(name → value)
  return {
    store(host, setCookieHeaders) {
      for (const header of setCookieHeaders) {
        const [pair, ...attrs] = header.split(";").map((s) => s.trim());
        const eq = pair.indexOf("=");
        if (eq <= 0) continue;
        const domainAttr = attrs.find((a) => /^domain=/i.test(a))?.slice(7);
        const domain = (domainAttr ? domainAttr.replace(/^\.?/, ".") : host).toLowerCase();
        // Never accept a cookie for a domain the setting host is not inside.
        if (domain.startsWith(".") ? !`.${host}`.endsWith(domain) : domain !== host) continue;
        if (!byDomain.has(domain)) byDomain.set(domain, new Map());
        byDomain.get(domain).set(pair.slice(0, eq), pair.slice(eq + 1));
      }
    },
    header(host) {
      const pairs = [];
      for (const [domain, cookies] of byDomain) {
        const matches = domain.startsWith(".") ? `.${host}`.endsWith(domain) : domain === host;
        if (matches) for (const [k, v] of cookies) pairs.push(`${k}=${v}`);
      }
      return pairs.length ? pairs.join("; ") : undefined;
    },
  };
}

export function createClient({
  userAgent = DEFAULT_USER_AGENT,
  auth = null,
  requestsPerMinute,
  cacheDir,
  minIntervalMs = 0,
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
  const ceilingRpm =
    requestsPerMinute ?? defaultRequestsPerMinute({ userAgent, authenticated: Boolean(auth) });
  let pacedRpm = ceilingRpm;
  const stats = { requests: 0, cacheHits: 0, retries: 0, rateLimited: 0 };
  const jar = createCookieJar();
  let queue = Promise.resolve();
  let lastRequestAt = -Infinity;
  let lastMeteredAt = -Infinity;

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

  async function pace(metered) {
    let wait = lastRequestAt + minIntervalMs - now();
    if (metered) wait = Math.max(wait, lastMeteredAt + 60_000 / pacedRpm - now());
    if (wait > 0) await sleep(wait);
    lastRequestAt = now();
    if (metered) lastMeteredAt = lastRequestAt;
  }

  async function attempt(url, headers, retries) {
    const host = new URL(url).hostname;
    const metered = LIMITED_HOST.test(host) && !UNMETERED_HOSTS.has(host);
    let reauthorized = false;
    for (let tryNo = 0; ; tryNo++) {
      await pace(metered);
      stats.requests++;

      const sent = { "User-Agent": userAgent, ...headers };
      if (metered) {
        if (auth) Object.assign(sent, await auth.headers());
        const cookie = jar.header(host);
        if (cookie) sent.Cookie = cookie;
      }

      let response;
      let text;
      let failure;
      try {
        // The timeout covers the body as well as the headers.
        response = await fetchImpl(url, { headers: sent, signal: AbortSignal.timeout(timeoutMs) });
        text = await response.text();
        if (metered) jar.store(host, response.headers?.getSetCookie?.() ?? []);
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
          } else {
            if (metered)
              pacedRpm = Math.min(ceilingRpm, pacedRpm + Math.max(0.25, ceilingRpm / 100));
            return body;
          }
        } else if (response.status === 401 && auth && !reauthorized) {
          // Expired or revoked token: get a fresh one, once, without counting a retry.
          reauthorized = true;
          await auth.invalidate?.();
          tryNo--;
          continue;
        } else if (RETRYABLE.has(response.status)) {
          failure = `HTTP ${response.status}`;
          if (response.status === 429 && metered) {
            stats.rateLimited++;
            pacedRpm = Math.max(1, pacedRpm / 2);
          }
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
      log(
        `  retry ${tryNo + 1}/${retries} in ${Math.round(backoff / 1000)}s (${failure})` +
          (metered ? `, pace now ${Math.round(pacedRpm)}/min` : ""),
      );
      await sleep(backoff);
    }
  }

  /**
   * GET a JSON document. Requests are queued so concurrent callers still hit
   * the network one at a time. `retries` overrides `maxRetries` for calls
   * where repeating is pointless (a SPARQL query that timed out at 60 s will
   * time out again).
   */
  function getJson(url, { headers = {}, key = url, retries = maxRetries, cache = true } = {}) {
    const cached = cache ? readCache(key) : undefined;
    if (cached !== undefined) {
      stats.cacheHits++;
      return Promise.resolve(cached);
    }
    const run = queue.then(async () => {
      const body = await attempt(url, headers, retries);
      if (cache) writeCache(key, body);
      return body;
    });
    queue = run.catch(() => {});
    return run;
  }

  /** Store a body under a key without a request (for bodies fetched under another key). */
  function remember(key, body) {
    writeCache(key, body);
  }

  return {
    getJson,
    remember,
    peek: readCache,
    stats,
    get pace() {
      return { ceilingRpm, currentRpm: pacedRpm };
    },
  };
}

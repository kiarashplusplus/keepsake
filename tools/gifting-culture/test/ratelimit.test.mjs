/**
 * The rate-limit strategy, branch by branch: identity tiers, pacing, AIMD on
 * 429, credentials only where they belong, cookies returned, tokens refreshed,
 * and article text fetched only when its revision changed. Fake fetch, fake
 * clock, no network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createClient,
  createCookieJar,
  defaultRequestsPerMinute,
  isCompliantUserAgent,
} from "../lib/http.mjs";
import { authFromEnv, clientCredentials } from "../lib/oauth.mjs";
import { fetchArticle, lookupPages } from "../lib/wikipedia.mjs";

const WP = "https://en.wikipedia.org/w/api.php";

function fakeResponse(status, body, headers = {}, setCookies = []) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => headers[n.toLowerCase()] ?? null, getSetCookie: () => setCookies },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function harness(responder) {
  const calls = [];
  const sleeps = [];
  let clock = 0;
  return {
    calls,
    sleeps,
    fetchImpl: async (url, init) => {
      calls.push({ url, headers: init.headers });
      return responder(url, calls.length);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  };
}

test("User-Agent compliance: a URL or an email, or you are 'unidentified'", () => {
  assert.equal(
    isCompliantUserAgent("gifting-culture-pipeline/0.2 (Node.js; set WIKIMEDIA_USER_AGENT)"),
    false,
  );
  assert.equal(isCompliantUserAgent("KeepsakeBot/1.0 (https://example.org/bot)"), true);
  assert.equal(isCompliantUserAgent("KeepsakeBot/1.0 (ops@example.org)"), true);
  assert.equal(defaultRequestsPerMinute({ userAgent: "x/1", authenticated: false }), 8);
  assert.equal(
    defaultRequestsPerMinute({ userAgent: "x/1 (ops@example.org)", authenticated: false }),
    150,
  );
  assert.equal(defaultRequestsPerMinute({ userAgent: "x/1", authenticated: true }), 150);
});

test("paces Wikimedia API requests at 60000/rpm, and a 429 halves the pace", async () => {
  const h = harness((url, n) =>
    n === 2 ? fakeResponse(429, "", { "retry-after": "0" }) : fakeResponse(200, { ok: n }),
  );
  const client = createClient({ ...h, requestsPerMinute: 60 });
  await client.getJson(`${WP}?a`);
  await client.getJson(`${WP}?b`); // 429 once, then retried
  assert.equal(client.stats.rateLimited, 1);
  assert.equal(h.sleeps[0], 1000, "second request waits one 60/min slot");
  // After the 429: backoff (≥1 s), then the retry must also wait one slot at the halved pace (2 s).
  const paceWaits = h.sleeps.slice(2);
  assert.ok(
    paceWaits.some((ms) => ms > 0),
    `expected a pacing wait after backoff, got ${h.sleeps}`,
  );
  assert.ok(
    client.pace.currentRpm < 60 && client.pace.currentRpm >= 30,
    `pace ${client.pace.currentRpm}`,
  );
});

test("the Wikidata Query Service is serial but not metered", async () => {
  const h = harness(() => fakeResponse(200, { results: { bindings: [] } }));
  const client = createClient({ ...h, requestsPerMinute: 1 });
  await client.getJson("https://query.wikidata.org/sparql?query=a");
  await client.getJson("https://query.wikidata.org/sparql?query=b");
  assert.deepEqual(h.sleeps, []);
});

test("credentials go to Wikimedia API hosts only; a 401 refreshes once", async () => {
  let issued = 0;
  const auth = {
    kind: "test",
    headers: async () => ({ Authorization: `Bearer t${issued}` }),
    invalidate: () => issued++,
  };
  const h = harness((url, n) =>
    n === 1 ? fakeResponse(401, "expired") : fakeResponse(200, { ok: true }),
  );
  const client = createClient({ ...h, auth, requestsPerMinute: 6000 });
  await client.getJson(`${WP}?x`);
  assert.equal(h.calls[0].headers.Authorization, "Bearer t0");
  assert.equal(h.calls[1].headers.Authorization, "Bearer t1", "retried with a fresh token");
  assert.equal(client.stats.retries, 0, "re-auth is not a retry");

  await client.getJson("https://query.wikidata.org/sparql?q");
  await client.getJson("https://example.org/elsewhere");
  assert.equal(h.calls[2].headers.Authorization, undefined);
  assert.equal(h.calls[3].headers.Authorization, undefined);
});

test("cookies set by Wikimedia are returned to it, and to nobody else", async () => {
  const h = harness((url, n) =>
    n === 1
      ? fakeResponse(200, { ok: 1 }, {}, ["WMF-Session=abc; Domain=.wikipedia.org; Path=/; Secure"])
      : fakeResponse(200, { ok: n }),
  );
  const client = createClient({ ...h, requestsPerMinute: 6000 });
  await client.getJson(`${WP}?1`);
  await client.getJson(`${WP}?2`);
  await client.getJson("https://www.wikidata.org/w/api.php?3");
  assert.equal(h.calls[1].headers.Cookie, "WMF-Session=abc");
  assert.equal(h.calls[2].headers.Cookie, undefined);
});

test("cookie jar refuses a cookie for a domain the host is not inside", () => {
  const jar = createCookieJar();
  jar.store("en.wikipedia.org", ["evil=1; Domain=.example.org", "ok=2"]);
  assert.equal(jar.header("www.example.org"), undefined);
  assert.equal(jar.header("en.wikipedia.org"), "ok=2");
  assert.equal(jar.header("de.wikipedia.org"), undefined, "host-only cookie stays on its host");
});

test("client credentials: exchanged once, reused, refreshed near expiry; errors never echo the secret", async () => {
  let clock = 0;
  const posts = [];
  const fetchImpl = async (url, init) => {
    posts.push(Object.fromEntries(init.body));
    return fakeResponse(200, {
      access_token: `tok${posts.length}`,
      expires_in: 3600,
      token_type: "Bearer",
    });
  };
  const auth = clientCredentials({
    clientId: "id",
    clientSecret: "s3cret",
    userAgent: "x",
    fetchImpl,
    now: () => clock,
  });
  assert.deepEqual(await auth.headers(), { Authorization: "Bearer tok1" });
  assert.deepEqual(await auth.headers(), { Authorization: "Bearer tok1" });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].grant_type, "client_credentials");
  clock = 3600_000 - 60_000; // inside the early-refresh window
  assert.deepEqual(await auth.headers(), { Authorization: "Bearer tok2" });

  const failing = clientCredentials({
    clientId: "id",
    clientSecret: "s3cret",
    userAgent: "x",
    fetchImpl: async () => fakeResponse(401, { error: "invalid_client" }),
  });
  await assert.rejects(
    failing.headers(),
    (e) => /invalid_client/.test(e.message) && !e.message.includes("s3cret"),
  );
});

test("authFromEnv: client credentials win, then a static token, else none", () => {
  assert.equal(authFromEnv({}), null);
  assert.equal(authFromEnv({ WIKIMEDIA_ACCESS_TOKEN: "t" }).kind, "static-token");
  assert.equal(
    authFromEnv({
      WIKIMEDIA_ACCESS_TOKEN: "t",
      WIKIMEDIA_CLIENT_ID: "i",
      WIKIMEDIA_CLIENT_SECRET: "s",
    }).kind,
    "oauth2-client-credentials",
  );
});

test("lookupPages resolves redirects in one request and drops missing and disambiguation pages", async () => {
  const h = harness(() =>
    fakeResponse(200, {
      query: {
        normalized: [{ from: "etiquette in Japan", to: "Etiquette in Japan" }],
        redirects: [{ from: "Culture of Osaka", to: "Osaka" }],
        pages: [
          { title: "Etiquette in Japan", pageid: 1, revisions: [{ revid: 11, timestamp: "t" }] },
          {
            title: "Osaka",
            pageid: 2,
            revisions: [{ revid: 22 }],
            pageprops: { wikibase_item: "Q35765" },
          },
          {
            title: "Mercury",
            pageid: 3,
            revisions: [{ revid: 33 }],
            pageprops: { disambiguation: "" },
          },
          { title: "Gift-giving in Osaka", missing: true },
        ],
      },
    }),
  );
  const client = createClient({ ...h, requestsPerMinute: 6000 });
  const pages = await lookupPages(client, [
    "etiquette in Japan",
    "Culture of Osaka",
    "Mercury",
    "Gift-giving in Osaka",
  ]);
  assert.equal(h.calls.length, 1);
  assert.deepEqual([...pages.keys()], ["etiquette in Japan", "Culture of Osaka"]);
  assert.equal(pages.get("Culture of Osaka").wikidataId, "Q35765");
  assert.equal(pages.get("etiquette in Japan").revisionId, 11);
});

test("fetchArticle makes no request when the cache holds that revision, and one when it changed", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gc-rev-"));
  try {
    const extract = (revid) =>
      fakeResponse(200, {
        query: {
          pages: [
            { title: "Omiyage", pageid: 7, revisions: [{ revid }], extract: `text at ${revid}` },
          ],
        },
      });
    const h1 = harness(() => extract(100));
    const c1 = createClient({ ...h1, cacheDir: dir, requestsPerMinute: 6000 });
    assert.equal((await fetchArticle(c1, { pageId: 7, revisionId: 100 })).text, "text at 100");

    const h2 = harness(() => assert.fail("must not fetch an unchanged revision"));
    const c2 = createClient({ ...h2, cacheDir: dir, requestsPerMinute: 6000 });
    assert.equal((await fetchArticle(c2, { pageId: 7, revisionId: 100 })).text, "text at 100");

    const h3 = harness(() => extract(101));
    const c3 = createClient({ ...h3, cacheDir: dir, requestsPerMinute: 6000 });
    assert.equal((await fetchArticle(c3, { pageId: 7, revisionId: 101 })).text, "text at 101");
    assert.equal(h3.calls.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

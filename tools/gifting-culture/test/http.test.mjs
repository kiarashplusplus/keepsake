/**
 * The client's whole job is to be patient with Wikimedia and loud when
 * patience runs out. A fake fetch and a fake clock let every branch fail.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "../lib/http.mjs";

function fakeResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function harness(responses) {
  const calls = [];
  const sleeps = [];
  let clock = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const sleep = async (ms) => {
    sleeps.push(ms);
    clock += ms;
  };
  return { calls, sleeps, fetchImpl, sleep, now: () => clock };
}

test("honours Retry-After on 429, then returns the body", async () => {
  const h = harness([
    fakeResponse(429, "slow down", { "retry-after": "7" }),
    fakeResponse(200, { ok: 1 }),
  ]);
  const client = createClient({ ...h, minIntervalMs: 0 });
  assert.deepEqual(await client.getJson("https://x.test/a"), { ok: 1 });
  assert.equal(h.calls.length, 2);
  assert.ok(
    h.sleeps.some((ms) => ms >= 7000 && ms < 7250),
    `slept ${h.sleeps}`,
  );
  assert.equal(client.stats.retries, 1);
});

test("treats MediaWiki's maxlag error (HTTP 200) as retryable", async () => {
  const h = harness([
    fakeResponse(200, { error: { code: "maxlag", info: "lagged" } }),
    fakeResponse(200, { ok: 2 }),
  ]);
  const client = createClient({ ...h, minIntervalMs: 0 });
  assert.deepEqual(await client.getJson("https://x.test/b"), { ok: 2 });
});

test("other API errors fail immediately, naming the code", async () => {
  const h = harness([fakeResponse(200, { error: { code: "badvalue", info: "nope" } })]);
  const client = createClient({ ...h, minIntervalMs: 0 });
  await assert.rejects(client.getJson("https://x.test/c"), /badvalue/);
  assert.equal(h.calls.length, 1);
});

test("gives up loudly after the retry budget", async () => {
  const h = harness([fakeResponse(503, ""), fakeResponse(503, ""), fakeResponse(503, "")]);
  const client = createClient({ ...h, minIntervalMs: 0, maxRetries: 2 });
  await assert.rejects(client.getJson("https://x.test/d"), /gave up after 3 attempts \(HTTP 503\)/);
});

test("a 404 is not retried", async () => {
  const h = harness([fakeResponse(404, "missing")]);
  const client = createClient({ ...h, minIntervalMs: 0 });
  await assert.rejects(client.getJson("https://x.test/e"), /HTTP 404/);
  assert.equal(h.calls.length, 1);
});

test("sends the User-Agent and spaces requests by minIntervalMs", async () => {
  const h = harness([fakeResponse(200, { n: 1 }), fakeResponse(200, { n: 2 })]);
  const client = createClient({ ...h, minIntervalMs: 500, userAgent: "ua-under-test" });
  await Promise.all([client.getJson("https://x.test/1"), client.getJson("https://x.test/2")]);
  assert.equal(h.calls[0].init.headers["User-Agent"], "ua-under-test");
  assert.ok(h.sleeps.includes(500), `second request should wait 500 ms, slept ${h.sleeps}`);
});

test("caches successful bodies on disk; refresh bypasses the read", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gc-http-"));
  try {
    const h1 = harness([fakeResponse(200, { v: 1 })]);
    await createClient({ ...h1, cacheDir: dir, minIntervalMs: 0 }).getJson("https://x.test/f");

    const h2 = harness([]);
    const cached = createClient({ ...h2, cacheDir: dir, minIntervalMs: 0 });
    assert.deepEqual(await cached.getJson("https://x.test/f"), { v: 1 });
    assert.equal(h2.calls.length, 0);
    assert.equal(cached.stats.cacheHits, 1);

    const h3 = harness([fakeResponse(200, { v: 2 })]);
    assert.deepEqual(
      await createClient({ ...h3, cacheDir: dir, minIntervalMs: 0, refresh: true }).getJson(
        "https://x.test/f",
      ),
      { v: 2 },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed request is not cached", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gc-http-"));
  try {
    const h1 = harness([fakeResponse(404, "")]);
    await assert.rejects(
      createClient({ ...h1, cacheDir: dir, minIntervalMs: 0 }).getJson("https://x.test/g"),
    );
    const h2 = harness([fakeResponse(200, { v: 3 })]);
    assert.deepEqual(
      await createClient({ ...h2, cacheDir: dir, minIntervalMs: 0 }).getJson("https://x.test/g"),
      { v: 3 },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Retry-After is a floor: a stubborn '1' still backs off exponentially", async () => {
  const limited = () => fakeResponse(429, "", { "retry-after": "1" });
  const h = harness([limited(), limited(), limited(), fakeResponse(200, { ok: 1 })]);
  const client = createClient({ ...h, minIntervalMs: 0 });
  await client.getJson("https://x.test/h");
  const backoffs = h.sleeps.map((ms) => Math.floor(ms / 1000));
  assert.deepEqual(backoffs, [1, 2, 4]);
});

test("a request that never answers times out and is retried", async () => {
  let n = 0;
  const fetchImpl = (url, { signal }) =>
    n++ === 0
      ? new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)))
      : Promise.resolve(fakeResponse(200, { ok: "second" }));
  const client = createClient({
    fetchImpl,
    sleep: async () => {},
    minIntervalMs: 0,
    timeoutMs: 20,
  });
  // AbortSignal.timeout's timer is unref'd; in real use the open socket keeps
  // the process alive, here nothing does.
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    assert.deepEqual(await client.getJson("https://x.test/i"), { ok: "second" });
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(client.stats.retries, 1);
});

// Tests for e2e/support/serve.mjs — specifically the part of it that decides
// what happens when the child process dies.
//
// The wrapper's whole reason to exist is that `wrangler dev` exits fatally
// mid-suite (#104), so the only honest way to test it is against a child that
// really does exit. Real wrangler would be neither fast nor deterministic, so
// `E2E_SERVER_CHILD_COMMAND` swaps in a five-line node script that prints a
// couple of lines and exits 1 — that seam exists for these tests and is
// documented as such in serve.mjs.
//
// The assertions that matter are the ones that go red if the instrumentation
// is removed:
//   - the child's own output is retained and reprinted *and* still passed
//     through live (a marker printed once must appear exactly twice), and
//   - exceeding the restart threshold exits non-zero instead of restarting
//     forever, which is what stops a three-crash CI run from looking
//     byte-identical to a clean one.
//
// Run with: node --test apps/web/e2e/support/serve.test.mjs
//           (or `pnpm --filter @keepsake/web test`, which includes it)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVE_BIN = path.join(HERE, "serve.mjs");

/** What the fake child prints before dying, echoing wrangler's real shape:
 * a bare error line, then the debug-log path serve.mjs is supposed to scrape. */
const CRASH_MARKER = "fake-wrangler-death-marker";
const FAKE_LOG_PATH = "/tmp/keepsake-fake-wrangler.log";
const FAKE_CHILD = `
process.stdout.write("fake wrangler ready\\n");
process.stderr.write("${CRASH_MARKER}\\n");
process.stderr.write('\\u{1FAB5}  Logs were written to "${FAKE_LOG_PATH}"\\n');
process.exit(1);
`;

/**
 * Run serve.mjs with a fake child and return its combined output plus exit code.
 *
 * `env` is applied over a *stripped* copy of the ambient environment: both
 * `GITHUB_ACTIONS` and `E2E_MAX_WRANGLER_RESTARTS` change what serve.mjs does,
 * and GitHub sets the former on every runner. Inheriting it would mean a test
 * that passes on a laptop fails in CI — the exact trap preflight.test.mjs
 * documents. So every test states which world it is in.
 *
 * The public port is 0 (the OS picks one): nothing here drives HTTP traffic,
 * and a fixed port would collide with a real e2e run on the same machine.
 */
function runServe(env = {}, { child = FAKE_CHILD, upstreamPort = 0, onListening } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "keepsake-serve-"));
  const childScript = path.join(dir, "fake-wrangler.mjs");
  writeFileSync(childScript, child);

  const childEnv = { ...process.env };
  delete childEnv.GITHUB_ACTIONS;
  delete childEnv.E2E_MAX_WRANGLER_RESTARTS;

  const proc = spawn(process.execPath, [SERVE_BIN, "0", String(upstreamPort), "--", "--local"], {
    env: {
      ...childEnv,
      E2E_SERVER_CHILD_COMMAND: JSON.stringify([process.execPath, childScript]),
      // Keep the crash report out of the repo's real `e2e-diagnostics/`:
      // these tests crash the child on purpose, dozens of times.
      E2E_SERVER_REPORT_DIR: dir,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let announced = false;
  const noticeListening = () => {
    if (announced || !onListening) return;
    // serve.mjs prints the port the OS actually gave it, which is the only
    // way a test can aim traffic at a proxy it did not choose the port for.
    const match = /proxying http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
    if (!match) return;
    announced = true;
    onListening(Number(match[1]));
  };
  proc.stdout.on("data", (chunk) => {
    output += chunk;
    noticeListening();
  });
  proc.stderr.on("data", (chunk) => (output += chunk));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`serve.mjs did not exit within 20s. Output so far:\n${output}`));
    }, 20_000);
    proc.on("error", reject);
    proc.on("close", (code) => {
      clearTimeout(timer);
      // Read before the cleanup below removes the directory holding it.
      let report = "";
      try {
        report = readFileSync(path.join(dir, "e2e-server-crash.log"), "utf8");
      } catch {
        report = "";
      }
      rmSync(dir, { recursive: true, force: true });
      resolve({ code, output, report });
    });
  });
}

/**
 * A port with nothing behind it. Bound and released rather than hard-coded so
 * this cannot collide with a real service; the window between release and use
 * is the test's own, and nothing else in this file listens.
 */
async function findDeadPort() {
  const probe = http.createServer(() => {});
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}
const DEAD_UPSTREAM_PORT = await findDeadPort();

function occurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// ── retention ──────────────────────────────────────────────────────────

test("a crashed child's stderr is reprinted, and still passed through live", async () => {
  // Threshold 0 makes the very first death fatal, so the marker is printed
  // exactly twice: once live as the child writes it, once in the post-mortem
  // dump. Restore `stdio: "inherit"` in serve.mjs and the count drops to 1
  // (live only, nothing retained); drop the passthrough and it is also 1.
  const { code, output } = await runServe({ E2E_MAX_WRANGLER_RESTARTS: "0" });
  assert.equal(
    occurrences(output, CRASH_MARKER),
    2,
    `expected live + retained copy in:\n${output}`,
  );
  assert.match(output, /last \d+ line\(s\) of its output/);
  assert.notEqual(code, 0);
});

test("the post-mortem is also written to a file, so CI can upload it", async () => {
  // The console copy alone has proven unfindable: on both runs this was built
  // to explain, the job log ended in a cascade of ECONNREFUSED with no
  // retrievable `[e2e:server]` line, so the only record of why wrangler died
  // was lost. `.github/workflows/ci.yml` uploads this file on failure.
  const { report } = await runServe({ E2E_MAX_WRANGLER_RESTARTS: "0" });
  assert.match(report, /wrangler dev exited unexpectedly/);
  assert.match(report, new RegExp(CRASH_MARKER));
  // The give-up itself, which is what actually ends the run, lands there too.
  assert.match(report, /FATAL: wrangler dev died/);
});

test("a report-file it cannot write never takes the supervisor down with it", async () => {
  // The write happens on the crash path, where losing the ability to report
  // must not also cost the restart that keeps the suite alive.
  //
  // A regular file standing where a directory must go, rather than an
  // unwritable system path: `mkdir -p` over it fails with ENOTDIR on every
  // platform and as every user, including root in a container.
  const blocker = path.join(mkdtempSync(path.join(tmpdir(), "keepsake-blocked-")), "not-a-dir");
  writeFileSync(blocker, "");
  const { output, code } = await runServe({
    E2E_MAX_WRANGLER_RESTARTS: "0",
    E2E_SERVER_REPORT_DIR: path.join(blocker, "reports"),
  });
  assert.match(output, /could not write the crash report/);
  // Still the ordinary give-up, not a crash of its own.
  assert.match(output, /FATAL: wrangler dev died/);
  assert.notEqual(code, 0);
});

test("the wrangler debug-log path is scraped out of the child's output and reported", async () => {
  const { output } = await runServe({ E2E_MAX_WRANGLER_RESTARTS: "0" });
  assert.match(output, new RegExp(`wrangler debug log[^\\n]*: ${FAKE_LOG_PATH}`));
});

test("the child's stdout is retained too, not just stderr", async () => {
  const { output } = await runServe({ E2E_MAX_WRANGLER_RESTARTS: "0" });
  assert.match(output, /out\| fake wrangler ready/);
});

// ── this proxy's own view of the crash ─────────────────────────────────
//
// #104's whole difficulty is that wrangler cannot say why it died: its console
// message is empty by construction (`castErrorCause` wraps a serialized,
// non-`Error` cause in `new Error()`) and its debug log drops entries under
// load. So the crash report has to carry what only this side of the socket
// knows. These two go red if that record is removed.

/** A child that stays up long enough for a request to be in flight, then dies. */
const SLOW_DYING_CHILD = `
process.stdout.write("fake wrangler ready\\n");
setTimeout(() => {
  process.stderr.write("${CRASH_MARKER}\\n");
  process.exit(1);
}, 700);
`;

test("a request in flight when wrangler dies is named in the crash report", async () => {
  // A black-hole upstream: it accepts the connection and never answers, so
  // the request is still open at the moment the child dies — which is the
  // only kind of request a fatal ProxyWorker error is ever about.
  const blackHole = http.createServer(() => {});
  await new Promise((resolve) => blackHole.listen(0, "127.0.0.1", resolve));

  try {
    const { output } = await runServe(
      { E2E_MAX_WRANGLER_RESTARTS: "0" },
      {
        child: SLOW_DYING_CHILD,
        upstreamPort: blackHole.address().port,
        onListening: (port) => {
          const req = http.request({
            host: "127.0.0.1",
            port,
            path: "/still-open-when-it-died",
          });
          req.on("error", () => {});
          req.end();
        },
      },
    );

    assert.match(output, /1 request\(s\) in flight to wrangler when it died/);
    assert.match(output, /GET \/still-open-when-it-died \(\d+ms ago\)/);
  } finally {
    await new Promise((resolve) => blackHole.close(resolve));
  }
});

/**
 * The shape the black-hole test above cannot produce: a child that is *also*
 * the upstream, so its death resets the sockets the proxy is holding.
 *
 * That is real wrangler, and it is why #381's four crash reports all said "0
 * request(s) in flight" while a hundred tests were failing around them: the
 * reset settles the entry before the exit is even delivered, and the report
 * then waits a further 100ms to print. Nothing was wrong with the traffic; the
 * instrument was reading an empty map and honestly reporting it as empty.
 */
const SELF_HOSTING_DYING_CHILD = (port) => `
import http from "node:http";
process.stdout.write("fake wrangler ready\\n");
// Accepts the request and never answers it, so it is genuinely open when the
// process — and with it this socket — goes away.
http.createServer(() => {}).listen(${port}, "127.0.0.1");
setTimeout(() => {
  process.stderr.write("${CRASH_MARKER}\\n");
  process.exit(1);
}, 700);
`;

test("a request the crash itself reset is still named, not lost to the empty map", async () => {
  const port = await findDeadPort();
  const { output } = await runServe(
    { E2E_MAX_WRANGLER_RESTARTS: "0" },
    {
      child: SELF_HOSTING_DYING_CHILD(port),
      upstreamPort: port,
      onListening: (publicPort) => {
        const req = http.request({
          host: "127.0.0.1",
          port: publicPort,
          path: "/reset-by-the-death-itself",
        });
        req.on("error", () => {});
        req.end();
      },
    },
  );

  // The record that has to survive: what the request was, and that it ended by
  // being reset rather than answered. Before the settled-request history this
  // assertion had nothing to match — the report named no request at all.
  assert.match(
    output,
    /GET \/reset-by-the-death-itself request failed \((ECONNRESET|ECONNREFUSED)[^)]*\) after \d+ms/,
  );
  // And the empty in-flight list now says why it is empty, so the next reader
  // does not conclude from it that nothing was in flight.
  assert.match(output, /\(none — wrangler's own death resets its sockets/);
});

test("this proxy losing its own upstream socket is recorded, not swallowed", async () => {
  // Nothing is listening on the upstream port, so the forward fails the way
  // it would if wrangler's socket went away mid-request: the browser is
  // retried and never sees it, which is exactly why it has to be written down.
  const { output } = await runServe(
    { E2E_MAX_WRANGLER_RESTARTS: "0" },
    {
      child: SLOW_DYING_CHILD,
      upstreamPort: DEAD_UPSTREAM_PORT,
      onListening: (port) => {
        const req = http.request({ host: "127.0.0.1", port, path: "/no-one-home" });
        req.on("error", () => {});
        req.end();
      },
    },
  );

  assert.match(output, /proxy-side events so far: [^\n]*upstream-request-error=\d/);
  assert.match(
    output,
    /upstream-request-error GET \/no-one-home attempt=0 code=ECONNREFUSED reused=false/,
  );
});

// ── the ordinary path ──────────────────────────────────────────────────

/** A child that just serves, so a request can be followed all the way through
 * the proxy and back. Everything else in this file kills the child on purpose;
 * without this, a change to how requests are forwarded — the agent they go
 * out on, the body they carry — could break every real run with the suite
 * still green. */
const ECHO_CHILD = (port) => `
import http from "node:http";
process.stdout.write("fake wrangler ready\\n");
// Counted so the test can prove the second request really did come back on
// the first one's connection, rather than merely assert that it did.
let connections = 0;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    res.writeHead(201, {
      "content-type": "text/plain",
      "x-seen-path": req.url,
      "x-connections": String(connections),
    });
    res.end(Buffer.concat(chunks));
  });
});
server.on("connection", () => { connections += 1; });
server.listen(${port}, "127.0.0.1");
// Long enough for the requests below, then exit so the test never hangs.
setTimeout(() => process.exit(1), 3000);
`;

test("requests and their bodies survive the round trip, over a reused socket", async () => {
  const port = await findDeadPort();
  const seen = [];
  await runServe(
    { E2E_MAX_WRANGLER_RESTARTS: "0" },
    {
      child: ECHO_CHILD(port),
      upstreamPort: port,
      onListening: (publicPort) => {
        // Two in sequence: the second goes out on the pooled keep-alive socket
        // the first left behind, which is the path `upstreamAgent` owns.
        const send = (n, after) => {
          const req = http.request(
            { host: "127.0.0.1", port: publicPort, method: "POST", path: `/echo/${n}` },
            (res) => {
              const chunks = [];
              res.on("data", (c) => chunks.push(c));
              res.on("end", () => {
                seen.push({
                  status: res.statusCode,
                  path: res.headers["x-seen-path"],
                  connections: res.headers["x-connections"],
                  body: Buffer.concat(chunks).toString(),
                });
                after?.();
              });
            },
          );
          req.on("error", () => {});
          req.end(`body-${n}`);
        };
        send(1, () => send(2));
      },
    },
  );

  assert.deepEqual(
    seen.map(({ status, path: seenPath, body }) => ({ status, path: seenPath, body })),
    [
      { status: 201, path: "/echo/1", body: "body-1" },
      { status: 201, path: "/echo/2", body: "body-2" },
    ],
  );
  // The second request opened no new connection upstream: the pool handed it
  // the socket the first left behind. Compared rather than pinned to a number
  // because `waitForUpstream` may have already spent one connecting-and-
  // dropping while it waited for the child's server to come up.
  assert.equal(seen[1].connections, seen[0].connections);
});

// ── the restart threshold ──────────────────────────────────────────────

test("the default threshold absorbs three restarts and fails on the fourth death", async () => {
  const { code, output } = await runServe();
  // The budget #381 settled on: three deaths absorbed...
  assert.match(output, /restart #1\./);
  assert.match(output, /restart #3\./);
  // ...and the fourth ends the run rather than restarting forever.
  assert.equal(code, 1);
  assert.match(output, /FATAL: wrangler dev died 4 time\(s\)/);
  assert.match(output, /limit 3/);
  // A run that restarts forever would never print this and never exit.
  assert.doesNotMatch(output, /restart #4\./);
});

test("exceeding the threshold emits a ::error:: annotation under GitHub Actions", async () => {
  const { code, output } = await runServe({ GITHUB_ACTIONS: "true" });
  assert.equal(code, 1);
  assert.match(output, /^::error::e2e: wrangler dev died 4 time\(s\)/m);
  // The tolerated restart is annotated too, so even a survivable blip is
  // visible on the run rather than buried in the log.
  assert.match(output, /^::warning::e2e: wrangler dev died and was restarted/m);
});

test("outside GitHub Actions the annotations are absent but the failure is not", async () => {
  const { code, output } = await runServe();
  assert.equal(code, 1);
  assert.doesNotMatch(output, /^::(error|warning)::/m);
  assert.match(output, /FATAL: wrangler dev died 4 time\(s\)/);
});

test("E2E_MAX_WRANGLER_RESTARTS raises the threshold", async () => {
  const { code, output } = await runServe({ E2E_MAX_WRANGLER_RESTARTS: "5" });
  assert.equal(code, 1);
  assert.match(output, /restart #5\./);
  assert.match(output, /FATAL: wrangler dev died 6 time\(s\)/);
});

test("an unparseable threshold falls back to the default instead of disabling the check", async () => {
  const { code, output } = await runServe({ E2E_MAX_WRANGLER_RESTARTS: "banana" });
  assert.equal(code, 1);
  assert.match(output, /ignoring E2E_MAX_WRANGLER_RESTARTS=banana/);
  assert.match(output, /FATAL: wrangler dev died 4 time\(s\)/);
});

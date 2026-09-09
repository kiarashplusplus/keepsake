#!/usr/bin/env node
/**
 * Keeps a `wrangler dev` alive behind a stable port for the Playwright suite.
 *
 * Three problems, one wrapper.
 *
 * 1. **A connection that dies while `wrangler dev` is reading a request body
 *    kills `wrangler dev`.** Not the request — the whole process, exit code 1.
 *    `ProxyWorker.js` posts its fetch failure to the ProxyController as a
 *    *serialized* `{name, message, stack}` object; `castErrorCause` sees a
 *    non-`Error` and wraps it in `new Error()` — no message — and wrangler's
 *    top-level `handleError` prints `cause.message` and drops `reason`. So the
 *    entire user-visible diagnostic is a bare `✘ [ERROR]` with nothing after
 *    it. That emptiness is not a mystery; it is the signature of this path.
 *    Reproduced against wrangler 4.129 by sending one `PUT /photos` with
 *    `Content-Length: 5000000`, writing 64 KB and resetting the socket: dead
 *    first try, and the debug log of an *idle* instance names it in full —
 *    `Error in ProxyController: Error inside ProxyWorker … at castErrorCause …
 *    cause: { message: 'Network connection lost.' }`.
 *
 *    The app aborts in-flight fetches on purpose in several places
 *    (`app/give/details.tsx`'s postcode lookup on every keystroke,
 *    `useFeed` when the query changes, `app/item/[id].tsx` on unmount), and a
 *    browser closing a socket that way took the whole dev server down about
 *    one run in four.
 *
 *    So this process owns the public port and forwards to wrangler on an
 *    internal one. When the browser hangs up, only *this* proxy sees it: the
 *    upstream request is left to finish and its body drained, so wrangler
 *    never observes a dropped connection at all. Measured: 20 truncated
 *    uploads and 1,200 reset-mid-response requests through this proxy killed
 *    wrangler zero times; the same 20 uploads sent straight at it killed it on
 *    the first one.
 *
 * 2. **If wrangler exits anyway, restart it — but never silently.** The
 *    public port stays bound the whole time, and a request that arrives mid
 *    restart waits for the new process instead of getting
 *    `ECONNREFUSED`. `--persist-to` state is on disk, so D1/R2/KV survive.
 *
 *    What is *not* known is which connection breaks. #104 recorded three
 *    fatal exits in one 2.5-minute suite run and inferred a second, unrelated
 *    fault, because grepping all three wrangler debug logs for the problem-1
 *    signature found **zero** matches for `Network connection lost`,
 *    `emitErrorEvent` or `castErrorCause`. That inference does not hold:
 *    wrangler's `appendToDebugLogFile` is fire-and-forget behind a mutex, and
 *    under suite-level load it silently stops keeping up. Measured both ways
 *    against the same crash — idle instance: the full record is in the file;
 *    under load: the file froze mid-`Runtime.consoleAPICalled` and the error
 *    record never landed, reproducing #104's zero matches exactly. **The
 *    wrangler debug log cannot be trusted to hold the reason for a crash that
 *    happened under load**, so do not conclude anything from its absence.
 *
 *    Because of that, restarting is not enough on its own: an invisible crash
 *    plus Playwright's `retries` is a run that reports green whether wrangler
 *    died three times or none. So this keeps the last `RETAINED_LINES` lines
 *    of wrangler's own output, prints them (with the debug-log path wrangler
 *    just wrote) on every unexpected exit, and gives up rather than restarting
 *    forever once the restart count passes `E2E_MAX_WRANGLER_RESTARTS`.
 *
 *    Wrangler's own two channels are therefore both dead ends — the console
 *    message is empty by construction, the debug log is lossy under load — so
 *    the crash report below also carries *this proxy's* view of the same
 *    moment: every upstream socket failure, every client hang-up, the requests
 *    still in flight when wrangler died, and — because that last list is
 *    almost always empty by the time anyone can read it, which is what made
 *    #381's four samples unreadable — the last requests to *settle* and how
 *    each of them ended. That is the only record of the crash that is not
 *    written by the process that just died.
 *
 * 3. **A request in flight the instant wrangler dies must not just fail.**
 *    A crash landing between two requests surfaces as `ECONNRESET`/
 *    `ECONNREFUSED`/`socket hang up` on our end. An earlier version of this
 *    file only retried `GET`/`HEAD` here, reasoning that replaying a `POST` might
 *    double-apply it — but that reasoning was about a *different* failure
 *    (the browser itself hanging up mid-upload, handled by problem 1 above).
 *    Here the browser is still there, patiently waiting; nothing has been
 *    returned to it yet, so nothing observable has happened from its point of
 *    view, and it is exactly as safe to retry a `POST` as a `GET` — the
 *    request is buffered in full below so any method can be replayed against
 *    the freshly-restarted process. This was verified with a harness that
 *    kills the upstream on a timer under sustained write traffic (#12): before
 *    this fix, ~1.5% of requests surfaced as an unretried 502; after, zero did.
 *
 * Usage: `node serve.mjs <publicPort> <upstreamPort> -- <wrangler dev args…>`
 */
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [publicPortRaw, upstreamPortRaw, separator, ...wranglerArgs] = process.argv.slice(2);
if (separator !== "--") {
  console.error("usage: serve.mjs <publicPort> <upstreamPort> -- <wrangler dev args...>");
  process.exit(2);
}
const PUBLIC_PORT = Number(publicPortRaw);
const UPSTREAM_PORT = Number(upstreamPortRaw);
const UPSTREAM_HOST = "127.0.0.1";
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 100;

let stopping = false;
let child = null;
let restarts = 0;

/** How many of wrangler's own output lines to keep for the post-mortem. Big
 * enough to cover a request or two of context before a crash, small enough
 * that a suite-long run costs nothing to hold. */
const RETAINED_LINES = 200;
/** A single pathological line (a base64 body, a stack with no newlines) must
 * not be able to grow this buffer without bound either. */
const MAX_RETAINED_LINE_CHARS = 2_000;

/**
 * How many unexpected exits to absorb before failing the run outright.
 *
 * Was one, on #104's evidence of runs with one restart and runs with three.
 * #381 priced that choice: four CI runs in sixteen minutes, every one of them
 * dying exactly twice — the first absorbed invisibly, the second tripping this
 * limit into `giveUp`, which frees the public port and hands every remaining
 * test an `ECONNREFUSED`. All four passed on a plain re-run with no code
 * change, so a budget of one was not catching a broken build; it was failing
 * roughly half of all runs over a fault the wrapper had already recovered
 * from. Three absorbs the observed rate (with Playwright's `retries: 2`
 * covering the tests each death costs) and still refuses a run whose server
 * is genuinely unable to stay up.
 *
 * Raising it does not make a death quiet: every restart still prints the full
 * post-mortem, writes it to `e2e-diagnostics/`, and leaves a `::warning::`
 * annotation on the run.
 *
 * Set `E2E_MAX_WRANGLER_RESTARTS` to change it, or to a negative value / the
 * word `unlimited` for restart-forever when you are deliberately working
 * through a flaky local environment.
 */
const RESTART_LIMIT_ENV = "E2E_MAX_WRANGLER_RESTARTS";
const DEFAULT_RESTART_LIMIT = 3;

function readRestartLimit() {
  // Statically named rather than `process.env[RESTART_LIMIT_ENV]`: eslint's
  // expo/no-dynamic-env-var bans the computed form (bundlers inline env reads).
  const raw = process.env.E2E_MAX_WRANGLER_RESTARTS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_RESTART_LIMIT;
  if (raw.trim().toLowerCase() === "unlimited") return Infinity;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    console.error(
      `[e2e:server] ignoring ${RESTART_LIMIT_ENV}=${raw} — not a number; using the default of ${DEFAULT_RESTART_LIMIT}.`,
    );
    return DEFAULT_RESTART_LIMIT;
  }
  return parsed < 0 ? Infinity : parsed;
}

const RESTART_LIMIT = readRestartLimit();

/**
 * The child command. `wrangler dev` in every real run; overridable only so the
 * supervisor's crash handling can be tested against a process that exits on
 * demand (`serve.test.mjs`) — there is no way to exercise "wrangler died"
 * with real wrangler that is either fast or deterministic. A JSON array of
 * argv, e.g. `["node", "crash.mjs"]`.
 */
const CHILD_COMMAND_ENV = "E2E_SERVER_CHILD_COMMAND";

function childCommand() {
  const override = process.env.E2E_SERVER_CHILD_COMMAND;
  if (!override) {
    return ["pnpm", ["exec", "wrangler", "dev", "--port", String(UPSTREAM_PORT), ...wranglerArgs]];
  }
  const argv = JSON.parse(override);
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => typeof a !== "string")) {
    throw new TypeError(`${CHILD_COMMAND_ENV} must be a JSON array of strings`);
  }
  return [argv[0], argv.slice(1)];
}

/**
 * This proxy's own view of what was happening when wrangler died. Wrangler
 * cannot supply it: its console message is empty by construction and its
 * debug log is lossy under load (see problem 2 above). Every entry here is
 * something only this side of the socket can see.
 */
const PROXY_EVENTS = 100;
const proxyEvents = [];
const proxyEventCounts = new Map();
function noteProxyEvent(kind, detail) {
  proxyEventCounts.set(kind, (proxyEventCounts.get(kind) ?? 0) + 1);
  proxyEvents.push(`${new Date().toISOString()} ${kind} ${detail}`);
  if (proxyEvents.length > PROXY_EVENTS) proxyEvents.shift();
}

/**
 * Upstream requests written but not yet fully read back, by a per-request id.
 * A fatal ProxyWorker error is always *about* a request in flight, so this is
 * the shortlist of what triggered any given crash.
 */
const inFlight = new Map();
let nextRequestId = 1;

/**
 * The requests that *just* finished, which is where the answer actually lives.
 *
 * `inFlight` alone was silently useless, and #381 is the bill for it: four
 * crash reports from four CI runs, and seven of the eight said "0 request(s)
 * in flight to wrangler when it died". Not because nothing was in flight —
 * because wrangler dying resets every socket it holds, each reset fires
 * `upstreamReq`'s error handler, and each of those settles its entry. Those
 * resets land *before* Node delivers the child's `exit`, which is itself
 * reported a further 100ms later (see `child.on("exit")`). So `inFlight` is
 * reliably empty by the time anyone reads it, and the one field the
 * post-mortem exists to fill is the one field it cannot fill. `serve.test.mjs`
 * missed it because its fake upstream is a *separate* black-hole server that
 * outlives the child, so nothing settles and the map still has an entry —
 * a shape real wrangler, which is both the child and the upstream, never has.
 *
 * Hence this: the last `RECENT_REQUESTS` upstream requests to settle, each
 * with how it ended. A crash report now shows the resets themselves, and the
 * ordinary traffic in the seconds before them, which is what distinguishes
 * "a request broke and took wrangler with it" from "wrangler went away on its
 * own while the proxy was idle" — the two hypotheses #381 could not separate.
 */
const RECENT_REQUESTS = 25;
const recentRequests = [];
/** When an upstream request last started or finished; `reportCrash` prints the
 * gap so a death during a quiet patch is legible as one. */
let lastUpstreamActivityAt = Date.now();

function noteSettled(entry, outcome) {
  const endedAt = Date.now();
  lastUpstreamActivityAt = endedAt;
  recentRequests.push(
    `${new Date(endedAt).toISOString()} ${entry.method} ${entry.url} ` +
      `${outcome} after ${endedAt - entry.startedAt}ms`,
  );
  if (recentRequests.length > RECENT_REQUESTS) recentRequests.shift();
}

/** Last `RETAINED_LINES` lines of the child's output, as `"out"`/`"err"` tags. */
const retained = [];
/** The debug log wrangler announces with `🪵  Logs were written to "…"`. */
let wranglerLogPath = null;
const WRANGLER_LOG_RE = /Logs were written to\s+"([^"]+)"/;

function retainLine(streamName, line) {
  const trimmed = line.replace(/\r$/, "").slice(0, MAX_RETAINED_LINE_CHARS);
  retained.push(`${streamName}| ${trimmed}`);
  if (retained.length > RETAINED_LINES) retained.shift();
  const match = WRANGLER_LOG_RE.exec(trimmed);
  if (match) wranglerLogPath = match[1];
}

/**
 * Tee one of the child's streams: every byte still goes straight through to
 * our own stdio (live output is byte-for-byte what `stdio: "inherit"` gave),
 * and a copy is split into lines for the ring buffer.
 */
function tee(source, sink, streamName) {
  let pending = "";
  const flush = () => {
    if (pending === "") return;
    retainLine(streamName, pending);
    pending = "";
  };
  source.on("data", (chunk) => {
    sink.write(chunk);
    pending += chunk.toString("utf8");
    let index;
    while ((index = pending.indexOf("\n")) !== -1) {
      retainLine(streamName, pending.slice(0, index));
      pending = pending.slice(index + 1);
    }
    if (pending.length > MAX_RETAINED_LINE_CHARS) flush();
  });
  source.on("end", flush);
  return flush;
}

function reportCrash(code, signal, inFlightAtExit) {
  const lines = [
    `[e2e:server] ---- wrangler dev exited unexpectedly (code=${code} signal=${signal}) ----`,
    `[e2e:server] last ${retained.length} line(s) of its output; "out|"/"err|" marks the stream:`,
  ];
  lines.push(
    ...(retained.length > 0
      ? retained.map((line) => `[e2e:server]   ${line}`)
      : ["[e2e:server]   (nothing captured)"]),
  );
  lines.push(
    wranglerLogPath
      ? `[e2e:server] wrangler debug log (often missing the error itself — see this file's header): ${wranglerLogPath}`
      : "[e2e:server] wrangler printed no debug-log path before dying.",
  );

  const now = Date.now();
  const stillOpen = inFlightAtExit.map(
    ({ method, url, startedAt }) => `${method} ${url} (${now - startedAt}ms ago)`,
  );
  lines.push(
    `[e2e:server] ${stillOpen.length} request(s) in flight to wrangler when it died:`,
    ...(stillOpen.length > 0
      ? stillOpen.map((entry) => `[e2e:server]   ${entry}`)
      : [
          "[e2e:server]   (none — wrangler's own death resets its sockets, which " +
            "settles them a moment before this fires; the history below is where to look)",
        ]),
  );
  lines.push(
    `[e2e:server] last upstream activity ${now - lastUpstreamActivityAt}ms before this report.`,
    `[e2e:server] last ${recentRequests.length} upstream request(s) to settle, oldest first:`,
    ...(recentRequests.length > 0
      ? recentRequests.map((entry) => `[e2e:server]   ${entry}`)
      : ["[e2e:server]   (none)"]),
  );

  const tally = [...proxyEventCounts.entries()].map(([kind, count]) => `${kind}=${count}`);
  lines.push(
    `[e2e:server] proxy-side events so far: ${tally.length > 0 ? tally.join(" ") : "(none)"}`,
  );
  if (proxyEvents.length > 0) {
    lines.push(
      `[e2e:server] last ${proxyEvents.length} proxy-side event(s):`,
      ...proxyEvents.map((entry) => `[e2e:server]   ${entry}`),
    );
  }
  const report = lines.join("\n");
  console.error(report);
  alsoWriteToReportFile(`${new Date().toISOString()} ${report}`);
}

/** GitHub renders `::error::` as an annotation on the run itself, so a suite
 * that survived on retries still carries a visible mark. */
function annotate(level, message) {
  if (process.env.GITHUB_ACTIONS) console.error(`::${level}::${message}`);
}

/**
 * The post-mortem also goes to a file, because on CI the console copy has
 * proven impossible to find. Playwright pipes this process's output through
 * its own reporter interleaved with 170 tests' worth of logs, and the two
 * runs this was built to explain (`main` on 9db94a9, and #340) both ended
 * with a full cascade of `ECONNREFUSED` and *no* retrievable `[e2e:server]`
 * line anywhere in the job log — the one record of why wrangler died was
 * written and then lost.
 *
 * Its own directory rather than `playwright-report/`: that folder belongs to
 * the HTML reporter, which rewrites it wholesale when it emits the report at
 * the end of a run, and a file appended mid-run is not guaranteed to survive
 * that. `.github/workflows/ci.yml` uploads this directory alongside the HTML
 * report on failure. `E2E_SERVER_REPORT_DIR` overrides it so
 * `serve.test.mjs` can point at a temp dir instead of the real one.
 *
 * Appends rather than truncates: a run may crash more than once (that is the
 * whole reason `RESTART_LIMIT` exists), and the earlier crash is usually the
 * informative one.
 */
const REPORT_DIR =
  process.env.E2E_SERVER_REPORT_DIR ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "e2e-diagnostics");
const REPORT_FILE = path.join(REPORT_DIR, "e2e-server-crash.log");
let reportFileBroken = false;

/**
 * Never throws and never takes the supervisor down with it: this runs on the
 * crash path, where losing the ability to *report* must not also cost the
 * restart that keeps the suite alive.
 */
function alsoWriteToReportFile(text) {
  if (reportFileBroken) return;
  try {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.appendFileSync(REPORT_FILE, `${text}\n`);
  } catch (error) {
    reportFileBroken = true;
    console.error(
      `[e2e:server] could not write the crash report to ${REPORT_FILE} (${error.message}); ` +
        "the copy above is the only one.",
    );
  }
}

function giveUp() {
  stopping = true;
  const message =
    `wrangler dev died ${restarts} time(s) during the e2e run (limit ${RESTART_LIMIT}, ` +
    `override with ${RESTART_LIMIT_ENV}). Which connection broke is in the captured ` +
    `output above, not in wrangler's own — see issue #104 and this file's header.`;
  console.error(`[e2e:server] FATAL: ${message}`);
  alsoWriteToReportFile(`[e2e:server] FATAL: ${message}`);
  annotate("error", `e2e: ${message}`);
  child?.kill("SIGTERM");
  proxy.close();
  process.exit(1);
}

function startWrangler() {
  const [command, args] = childCommand();
  child = spawn(command, args, {
    // Not `"inherit"`: the whole point is to retain what wrangler said on its
    // way out. Both streams are teed back to ours, so live output is unchanged.
    stdio: ["inherit", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });

  const flushOut = tee(child.stdout, process.stdout, "out");
  const flushErr = tee(child.stderr, process.stderr, "err");

  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) return;
    restarts += 1;
    // Taken here rather than inside the timeout below: whatever is left in
    // `inFlight` at the moment of exit is already a weaker record than it looks
    // (see `recentRequests`), and waiting 100ms to read it guarantees it is
    // empty. Snapshot first, ask questions later.
    const inFlightAtExit = [...inFlight.values()];
    // The pool is full of sockets to a process that no longer exists, and
    // `waitForUpstream` will clear replays the instant the *port* answers.
    // Drop them now so those replays reach the new process instead.
    upstreamAgent.destroy();
    // `exit` can fire while the last bytes of a crash message are still in the
    // pipe, and those are precisely the lines this exists to keep. Give the
    // reader a beat to drain before reporting; a restart takes seconds anyway.
    setTimeout(() => {
      flushOut();
      flushErr();
      reportCrash(code, signal, inFlightAtExit);
      if (restarts > RESTART_LIMIT) {
        giveUp();
        return;
      }
      console.error(
        `[e2e:server] wrangler dev exited unexpectedly (code=${code} signal=${signal}) — restart #${restarts}. ` +
          "Requests arriving meanwhile will wait for the new process rather than fail.",
      );
      annotate(
        "warning",
        `e2e: wrangler dev died and was restarted (restart #${restarts} of at most ${RESTART_LIMIT}). See issue #104.`,
      );
      startWrangler();
    }, 100);
  });
}

function upstreamReachable() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: UPSTREAM_HOST, port: UPSTREAM_PORT });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function waitForUpstream() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (await upstreamReachable()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
}

/**
 * This proxy's own connection pool to wrangler, owned rather than left to
 * `http.globalAgent`, for one reason: it has to be emptied when the child dies.
 *
 * Node's global agent has kept connections alive by default since v19, and
 * `waitForUpstream` clears a request to be replayed as soon as *the port*
 * accepts a TCP connection — which the freshly restarted wrangler does while
 * the pool still holds sockets to the corpse of the old one. A replay then
 * goes out on a dead socket and fails again. #381's run 34391081815 shows the
 * whole shape: eleven asset requests reset at 18:55:42, waited out the
 * restart, and eleven of the same URLs reset again eight seconds later, most
 * of them `reused=true`. Destroying the pool on exit (below) spends those
 * retries on the process that is actually alive.
 */
const upstreamAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });

/** How many times a request may be replayed against a freshly-restarted
 * wrangler before this gives up and answers 502. Bounded so a genuinely
 * broken upstream still fails a test instead of retrying forever; in
 * practice a real crash-and-restart is resolved well within this. */
const MAX_ATTEMPTS = 5;

const proxy = http.createServer((req, res) => {
  void (async () => {
    // Buffer the whole body before forwarding anything. Two reasons: a
    // retry needs to resend the exact same bytes, and a Node stream can't be
    // rewound once read; and buffering here means a browser that hangs up
    // mid-upload (`req` errors/aborts) is fully decoupled from wrangler's
    // socket — nothing partial ever reaches it either way.
    const bodyChunks = [];
    const bodyOutcome = await new Promise((resolve) => {
      req.on("data", (chunk) => bodyChunks.push(chunk));
      req.on("end", () => resolve("complete"));
      req.on("aborted", () => resolve("aborted"));
      req.on("error", () => resolve("aborted"));
    });
    if (bodyOutcome === "aborted") {
      // The browser gave up before finishing its own request. There is no
      // complete request to forward and no one left waiting on a response.
      // Recorded because this is exactly the hang-up that is fatal one hop
      // upstream: it must never be seen to reach wrangler.
      noteProxyEvent("client-abort-mid-body", `${req.method} ${req.url}`);
      if (!res.destroyed) res.end();
      return;
    }
    const body = Buffer.concat(bodyChunks);

    const forward = async (attempt) => {
      // Only the retries wait for the port. The first attempt is the happy
      // path 99.9% of the time, and probing it cost a second TCP connect to
      // wrangler for *every* request — pure churn against the one process
      // this file exists to keep alive. If the upstream really is down, the
      // first attempt fails immediately with `ECONNREFUSED` and attempt 1
      // does the waiting, which is the same outcome one error line later.
      if (attempt > 0 && !(await waitForUpstream())) {
        noteProxyEvent("upstream-never-returned", `${req.method} ${req.url}`);
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("e2e proxy: wrangler dev never came back\n");
        return;
      }

      const requestId = nextRequestId++;
      const startedAt = Date.now();
      lastUpstreamActivityAt = startedAt;
      inFlight.set(requestId, { method: req.method, url: req.url, startedAt });
      /** Idempotent: `end` and `error` can both fire on the same response, and
       * the first one to arrive is the one that describes what happened. */
      const settle = (outcome) => {
        const entry = inFlight.get(requestId);
        if (!entry) return;
        inFlight.delete(requestId);
        noteSettled(entry, outcome);
      };

      const upstreamReq = http.request(
        {
          host: UPSTREAM_HOST,
          port: UPSTREAM_PORT,
          method: req.method,
          path: req.url,
          headers: req.headers,
          agent: upstreamAgent,
        },
        (upstreamRes) => {
          if (res.writableEnded || res.destroyed) {
            // The browser has already hung up. Drain rather than destroy: the
            // whole point of this proxy is that wrangler never sees the abort.
            noteProxyEvent("client-gone-before-response", `${req.method} ${req.url}`);
            upstreamRes.on("end", () => settle("drained (client had gone)"));
            upstreamRes.on("error", () => settle("upstream error while draining"));
            upstreamRes.resume();
            return;
          }
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          let clientLeftMidBody = false;
          upstreamRes.on("data", (chunk) => {
            if (res.destroyed) {
              if (!clientLeftMidBody) {
                clientLeftMidBody = true;
                noteProxyEvent("client-gone-mid-response", `${req.method} ${req.url}`);
              }
              return;
            }
            res.write(chunk);
          });
          upstreamRes.on("end", () => {
            settle(`ok ${upstreamRes.statusCode ?? "?"}`);
            if (!res.destroyed) res.end();
          });
          // Response headers are already committed to the browser at this
          // point, so a reset mid-body can't be retried — just end what we
          // have rather than let an unhandled stream error take the proxy
          // down with it.
          upstreamRes.on("error", (error) => {
            settle(`response reset (${error.code ?? "?"})`);
            noteProxyEvent(
              "upstream-response-error",
              `${req.method} ${req.url} ${error.code ?? ""} ${error.message}`,
            );
            if (!res.destroyed) res.end();
          });
        },
      );

      upstreamReq.on("error", (error) => {
        settle(`request failed (${error.code ?? "?"} reused=${upstreamReq.reusedSocket === true})`);
        // The load-bearing record. This proxy losing its own socket to
        // wrangler mid-request is indistinguishable, from wrangler's side,
        // from the browser hang-up in problem 1 — and just as fatal. If a
        // crash report shows one of these immediately before the exit, the
        // leak is on this leg, and `reused` says whether a pooled keep-alive
        // socket went stale under us.
        noteProxyEvent(
          "upstream-request-error",
          `${req.method} ${req.url} attempt=${attempt} code=${error.code ?? "?"} ` +
            `reused=${upstreamReq.reusedSocket === true} ${error.message}`,
        );
        if (res.headersSent || res.destroyed) {
          if (!res.destroyed) res.end();
          return;
        }
        // Nothing has reached the browser yet — no status line, no bytes —
        // so replaying the exact buffered request against a (possibly
        // just-restarted) wrangler is safe no matter the method. See this
        // file's header, problem 3.
        if (attempt < MAX_ATTEMPTS) {
          void forward(attempt + 1);
          return;
        }
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(`e2e proxy: ${error.message}\n`);
      });

      upstreamReq.end(body);
    };

    await forward(0);
  })();
});

// Nothing in this app upgrades to a WebSocket, and forwarding one would
// reintroduce exactly the socket-teardown path this proxy exists to hide.
proxy.on("clientError", (error, socket) => {
  noteProxyEvent("client-protocol-error", `${error.code ?? "?"} ${error.message}`);
  socket.destroy();
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    stopping = true;
    child?.kill(signal);
    proxy.close();
    process.exit(0);
  });
}

startWrangler();
proxy.listen(PUBLIC_PORT, UPSTREAM_HOST, () => {
  // The *bound* port, not the requested one: passing 0 asks the OS to pick,
  // which is how serve.test.mjs drives real traffic through this proxy
  // without racing a hard-coded port against a real e2e run.
  const boundPort = proxy.address().port;
  console.log(
    `[e2e:server] proxying http://${UPSTREAM_HOST}:${boundPort} -> wrangler dev on :${UPSTREAM_PORT}`,
  );
});

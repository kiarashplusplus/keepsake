#!/usr/bin/env node
/**
 * Keeps a `wrangler dev` alive behind a stable port for the Playwright suite.
 *
 * Three problems, one wrapper.
 *
 * 1. **`wrangler dev` dies when a client hangs up mid-request.** One error
 *    surfacing from its internal ProxyWorker is fatal:
 *    `Error inside ProxyWorker: Network connection lost` (`castErrorCause` ->
 *    `ProxyController.emitErrorEvent` in the wrangler debug log). The app
 *    aborts in-flight fetches on purpose in several places
 *    (`app/give/details.tsx`'s postcode lookup on every keystroke,
 *    `useFeed` when the query changes, `app/item/[id].tsx` on unmount), and a
 *    browser closing a socket that way took the whole dev server down about
 *    one run in four.
 *
 *    So this process owns the public port and forwards to wrangler on an
 *    internal one. When the browser hangs up, only *this* proxy sees it: the
 *    upstream request is left to finish and its body drained, so wrangler
 *    never observes a dropped connection at all.
 *
 * 2. **If wrangler exits anyway, restart it — but never silently.** The
 *    public port stays bound the whole time, and a request that arrives mid
 *    restart waits for the new process instead of getting
 *    `ECONNREFUSED`. `--persist-to` state is on disk, so D1/R2/KV survive.
 *
 *    What is *not* known is why wrangler exits. #104 recorded three fatal
 *    exits in one 2.5-minute suite run, each printing a bare `✘ [ERROR]`
 *    with an empty message — and grepping all three wrangler debug logs for
 *    the problem-1 signature above found **zero** matches for
 *    `Network connection lost`, `emitErrorEvent` or `castErrorCause`. The
 *    logs simply end mid-normal-traffic with no error record. So at least one
 *    *other*, still-unidentified fault kills `wrangler dev` here, and it
 *    writes no diagnostic anywhere. Do not read the paragraph above as an
 *    explanation for every restart line you see.
 *
 *    Because of that, restarting is not enough on its own: an invisible crash
 *    plus Playwright's `retries` is a run that reports green whether wrangler
 *    died three times or none. So this keeps the last `RETAINED_LINES` lines
 *    of wrangler's own output, prints them (with the debug-log path wrangler
 *    just wrote) on every unexpected exit, and gives up rather than restarting
 *    forever once the restart count passes `E2E_MAX_WRANGLER_RESTARTS`.
 *
 * 3. **A request in flight the instant wrangler dies must not just fail.**
 *    `waitForUpstream()` confirms the port is accepting connections right
 *    before every attempt, but a crash landing in the gap between that check
 *    and the real request still surfaces as `ECONNRESET`/`ECONNREFUSED`/
 *    `socket hang up` on our end. An earlier version of this file only
 *    retried `GET`/`HEAD` here, reasoning that replaying a `POST` might
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
import http from "node:http";
import net from "node:net";

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
 * One is deliberate rather than arbitrary: #104 saw runs with one restart and
 * runs with three, so tolerating a single blip keeps the suite usable while
 * still refusing to let a three-crash run look like a clean one. Set
 * `E2E_MAX_WRANGLER_RESTARTS` to raise it, or to a negative value / the word
 * `unlimited` for the old restart-forever behaviour when you are deliberately
 * working through a flaky local environment.
 */
const RESTART_LIMIT_ENV = "E2E_MAX_WRANGLER_RESTARTS";
const DEFAULT_RESTART_LIMIT = 1;

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

function reportCrash(code, signal) {
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
      ? `[e2e:server] wrangler debug log: ${wranglerLogPath}`
      : "[e2e:server] wrangler printed no debug-log path before dying.",
  );
  console.error(lines.join("\n"));
}

/** GitHub renders `::error::` as an annotation on the run itself, so a suite
 * that survived on retries still carries a visible mark. */
function annotate(level, message) {
  if (process.env.GITHUB_ACTIONS) console.error(`::${level}::${message}`);
}

function giveUp() {
  stopping = true;
  const message =
    `wrangler dev died ${restarts} time(s) during the e2e run (limit ${RESTART_LIMIT}, ` +
    `override with ${RESTART_LIMIT_ENV}). Cause is unknown — see issue #104 and the ` +
    `captured output above.`;
  console.error(`[e2e:server] FATAL: ${message}`);
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
    // `exit` can fire while the last bytes of a crash message are still in the
    // pipe, and those are precisely the lines this exists to keep. Give the
    // reader a beat to drain before reporting; a restart takes seconds anyway.
    setTimeout(() => {
      flushOut();
      flushErr();
      reportCrash(code, signal);
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
      if (!res.destroyed) res.end();
      return;
    }
    const body = Buffer.concat(bodyChunks);

    const forward = async (attempt) => {
      if (!(await waitForUpstream())) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("e2e proxy: wrangler dev never came back\n");
        return;
      }

      const upstreamReq = http.request(
        {
          host: UPSTREAM_HOST,
          port: UPSTREAM_PORT,
          method: req.method,
          path: req.url,
          headers: req.headers,
        },
        (upstreamRes) => {
          if (res.writableEnded || res.destroyed) {
            // The browser has already hung up. Drain rather than destroy: the
            // whole point of this proxy is that wrangler never sees the abort.
            upstreamRes.resume();
            return;
          }
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.on("data", (chunk) => {
            if (!res.destroyed) res.write(chunk);
          });
          upstreamRes.on("end", () => {
            if (!res.destroyed) res.end();
          });
          // Response headers are already committed to the browser at this
          // point, so a reset mid-body can't be retried — just end what we
          // have rather than let an unhandled stream error take the proxy
          // down with it.
          upstreamRes.on("error", () => {
            if (!res.destroyed) res.end();
          });
        },
      );

      upstreamReq.on("error", (error) => {
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
proxy.on("clientError", (_error, socket) => socket.destroy());

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
  console.log(
    `[e2e:server] proxying http://${UPSTREAM_HOST}:${PUBLIC_PORT} -> wrangler dev on :${UPSTREAM_PORT}`,
  );
});

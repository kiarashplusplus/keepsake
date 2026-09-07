#!/usr/bin/env node
/**
 * Keeps a `wrangler dev` alive behind a stable port for the Playwright suite.
 *
 * Three problems, one wrapper.
 *
 * 1. **`wrangler dev` dies when a client hangs up mid-request.** Any error
 *    surfacing from its internal ProxyWorker is fatal — including
 *    `Error inside ProxyWorker: Network connection lost` (seen as a bare
 *    `✘ [ERROR]` with an empty message; `castErrorCause` ->
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
 * 2. **If wrangler exits anyway, restart it without failing the run.** The
 *    public port stays bound the whole time, and a request that arrives mid
 *    restart waits for the new process instead of getting
 *    `ECONNREFUSED`. `--persist-to` state is on disk, so D1/R2/KV survive.
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

function startWrangler() {
  child = spawn(
    "pnpm",
    ["exec", "wrangler", "dev", "--port", String(UPSTREAM_PORT), ...wranglerArgs],
    {
      stdio: "inherit",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );

  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) return;
    restarts += 1;
    console.error(
      `[e2e:server] wrangler dev exited unexpectedly (code=${code} signal=${signal}) — restart #${restarts}. ` +
        "Requests arriving meanwhile will wait for the new process rather than fail.",
    );
    startWrangler();
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

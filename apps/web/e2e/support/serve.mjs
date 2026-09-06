#!/usr/bin/env node
/**
 * Keeps a `wrangler dev` alive behind a stable port for the Playwright suite.
 *
 * Two problems, one wrapper.
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
 * Usage: `node serve.mjs <publicPort> <upstreamPort> -- <wrangler dev args…>`
 */
import { spawn } from "node:child_process";
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
  child = spawn("pnpm", ["exec", "wrangler", "dev", "--port", String(UPSTREAM_PORT), ...wranglerArgs], {
    stdio: "inherit",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });

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

/** Safe to replay: no body was consumed, and neither verb changes state. A
 * request that was in flight when wrangler died is the one case a restart
 * would otherwise still cost a test, and in practice it is almost always a
 * navigation or an asset fetch. */
const REPLAYABLE_METHODS = new Set(["GET", "HEAD"]);

const proxy = http.createServer((req, res) => {
  void (async () => {
    const replayable = REPLAYABLE_METHODS.has(req.method ?? "");

    const forward = async (attemptsLeft) => {
      if (!(await waitForUpstream())) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end("e2e proxy: wrangler dev never came back\n");
        return;
      }

      const upstreamReq = http.request(
        { host: UPSTREAM_HOST, port: UPSTREAM_PORT, method: req.method, path: req.url, headers: req.headers },
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
        },
      );

      upstreamReq.on("error", (error) => {
        if (!res.headersSent && !res.destroyed && attemptsLeft > 0) {
          void forward(attemptsLeft - 1);
          return;
        }
        if (!res.headersSent && !res.destroyed) {
          res.writeHead(502, { "content-type": "text/plain" });
          res.end(`e2e proxy: ${error.message}\n`);
        } else if (!res.destroyed) {
          res.end();
        }
      });

      if (replayable) {
        // No body to forward — and nothing to re-consume if this attempt has
        // to be retried against a restarted wrangler.
        upstreamReq.end();
        return;
      }
      // A client that hangs up mid-upload still gets a well-formed request
      // upstream; nothing is destroyed on wrangler's side.
      req.on("aborted", () => upstreamReq.end());
      req.pipe(upstreamReq);
    };

    await forward(replayable ? 1 : 0);
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
  console.log(`[e2e:server] proxying http://${UPSTREAM_HOST}:${PUBLIC_PORT} -> wrangler dev on :${UPSTREAM_PORT}`);
});

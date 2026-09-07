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
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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
function runServe(env = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "keepsake-serve-"));
  const childScript = path.join(dir, "fake-wrangler.mjs");
  writeFileSync(childScript, FAKE_CHILD);

  const childEnv = { ...process.env };
  delete childEnv.GITHUB_ACTIONS;
  delete childEnv.E2E_MAX_WRANGLER_RESTARTS;

  const proc = spawn(process.execPath, [SERVE_BIN, "0", "0", "--", "--local"], {
    env: {
      ...childEnv,
      E2E_SERVER_CHILD_COMMAND: JSON.stringify([process.execPath, childScript]),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  proc.stdout.on("data", (chunk) => (output += chunk));
  proc.stderr.on("data", (chunk) => (output += chunk));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`serve.mjs did not exit within 20s. Output so far:\n${output}`));
    }, 20_000);
    proc.on("error", reject);
    proc.on("close", (code) => {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
      resolve({ code, output });
    });
  });
}

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

test("the wrangler debug-log path is scraped out of the child's output and reported", async () => {
  const { output } = await runServe({ E2E_MAX_WRANGLER_RESTARTS: "0" });
  assert.match(output, new RegExp(`wrangler debug log: ${FAKE_LOG_PATH}`));
});

test("the child's stdout is retained too, not just stderr", async () => {
  const { output } = await runServe({ E2E_MAX_WRANGLER_RESTARTS: "0" });
  assert.match(output, /out\| fake wrangler ready/);
});

// ── the restart threshold ──────────────────────────────────────────────

test("the default threshold absorbs one restart and fails on the second death", async () => {
  const { code, output } = await runServe();
  // Restart #1 happens...
  assert.match(output, /restart #1\./);
  // ...and the second death ends the run rather than restarting forever.
  assert.equal(code, 1);
  assert.match(output, /FATAL: wrangler dev died 2 time\(s\)/);
  assert.match(output, /limit 1/);
  // A run that restarts forever would never print this and never exit.
  assert.doesNotMatch(output, /restart #3\./);
});

test("exceeding the threshold emits a ::error:: annotation under GitHub Actions", async () => {
  const { code, output } = await runServe({ GITHUB_ACTIONS: "true" });
  assert.equal(code, 1);
  assert.match(output, /^::error::e2e: wrangler dev died 2 time\(s\)/m);
  // The tolerated restart is annotated too, so even a survivable blip is
  // visible on the run rather than buried in the log.
  assert.match(output, /^::warning::e2e: wrangler dev died and was restarted/m);
});

test("outside GitHub Actions the annotations are absent but the failure is not", async () => {
  const { code, output } = await runServe();
  assert.equal(code, 1);
  assert.doesNotMatch(output, /^::(error|warning)::/m);
  assert.match(output, /FATAL: wrangler dev died 2 time\(s\)/);
});

test("E2E_MAX_WRANGLER_RESTARTS raises the threshold", async () => {
  const { code, output } = await runServe({ E2E_MAX_WRANGLER_RESTARTS: "3" });
  assert.equal(code, 1);
  assert.match(output, /restart #3\./);
  assert.match(output, /FATAL: wrangler dev died 4 time\(s\)/);
});

test("an unparseable threshold falls back to the default instead of disabling the check", async () => {
  const { code, output } = await runServe({ E2E_MAX_WRANGLER_RESTARTS: "banana" });
  assert.equal(code, 1);
  assert.match(output, /ignoring E2E_MAX_WRANGLER_RESTARTS=banana/);
  assert.match(output, /FATAL: wrangler dev died 2 time\(s\)/);
});

#!/usr/bin/env node
// Runs the whole test suite section by section and prints a summary table at
// the end, instead of stopping at the first red section. Adapted from
// finderly-monorepo's `scripts/readable-test-runner.mjs` (that version's
// npm-workspace line-classification machinery — PASS/FAIL header detection,
// jest/vitest summary parsing — is not needed here; this repo just needs
// pnpm swapped in for npm and one banner per section), stripped to what the
// plan actually asks for: colourised per-section output, non-fail-fast, a
// summary table, and an exit code that reflects any failure.
//
// Usage: node tools/readable-test-runner.mjs
import { spawn } from "node:child_process";
import readline from "node:readline";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
};

function colorize(text, ...styles) {
  if (!useColor || styles.length === 0) return text;
  return `${styles.join("")}${text}${ANSI.reset}`;
}

// One line per pnpm/vitest/jest failure header, so a scan of the log finds
// them even without reading every line — pnpm/vitest/jest all print one of
// these somewhere near a failure.
const WARNING_PATTERNS = [/\bWARN\b/, /\bERROR\b/i, /DeprecationWarning/];

function streamLines(stream, section) {
  const rl = readline.createInterface({ input: stream });
  const prefix = colorize(`[${section}]`, ANSI.bold, ANSI.cyan);
  rl.on("line", (line) => {
    const isWarning = WARNING_PATTERNS.some((p) => p.test(line));
    const styled = isWarning ? colorize(line, ANSI.yellow) : line;
    process.stdout.write(`${prefix} ${styled}\n`);
  });
}

function runSection(section, command, args) {
  process.stdout.write(`\n${colorize(`=== ${section} ===`, ANSI.bold, ANSI.cyan)}\n`);
  const child = spawn(command, args, { stdio: ["inherit", "pipe", "pipe"], env: process.env });
  streamLines(child.stdout, section);
  streamLines(child.stderr, section);

  return new Promise((resolve) => {
    child.on("close", (code, signal) => {
      if (signal) {
        resolve({ section, code: 1, signal });
        return;
      }
      resolve({ section, code: code ?? 1 });
    });
  });
}

// Each step runs even if an earlier one failed — a red PACKAGES step should
// not hide a red API step. `--if-present` on the pnpm filters means a
// workspace with no `test` script yet (M0 scaffold) is silently a no-op
// rather than a failure.
const STEPS = [
  { section: "PREFLIGHT", command: "node", args: ["tools/preflight/preflight.mjs"] },
  { section: "PACKAGES", command: "pnpm", args: ["--filter", "./packages/*", "--if-present", "test"] },
  { section: "API", command: "pnpm", args: ["--filter", "@keepsake/api", "--if-present", "test"] },
  { section: "WEB", command: "pnpm", args: ["--filter", "@keepsake/web", "--if-present", "test"] },
];

function printSummary(results) {
  process.stdout.write(`\n${colorize("=== SUMMARY ===", ANSI.bold, ANSI.cyan)}\n`);
  const width = Math.max(...results.map((r) => r.section.length));
  for (const { section, code } of results) {
    const ok = code === 0;
    const label = ok ? colorize("PASS", ANSI.bold, ANSI.green) : colorize("FAIL", ANSI.bold, ANSI.red);
    process.stdout.write(`  ${label}  ${section.padEnd(width)}\n`);
  }
  const failed = results.filter((r) => r.code !== 0);
  process.stdout.write("\n");
  if (failed.length > 0) {
    process.stdout.write(colorize(`${failed.length}/${results.length} section(s) failed.\n`, ANSI.bold, ANSI.red));
  } else {
    process.stdout.write(colorize(`All ${results.length} section(s) passed.\n`, ANSI.bold, ANSI.green));
  }
}

async function main() {
  const results = [];
  for (const step of STEPS) {
    results.push(await runSection(step.section, step.command, step.args));
  }
  printSummary(results);
  return results.some((r) => r.code !== 0) ? 1 : 0;
}

process.exit(await main());

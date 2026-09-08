// Fails the build when CI skipped a job the diff actually required.
//
// Why this exists. Every expensive job in ci.yml is gated on `dorny/paths-filter`
// output, and GitHub reports a *skipped* job as a green check. So any mistake in
// the filters is invisible: the pull request looks fully tested and nothing ran.
// That has now happened three times on this repo.
//
//   1. `e2e` was gated behind `test-api`, so every web-only change skipped the
//      end-to-end suite — the change it exists to check. It ran on nothing for
//      its first several commits.
//   2. `pull-requests: read` was missing, so `changes` failed, and every job
//      that needs its outputs skipped. Mostly-green, zero tests.
//   3. `apps/site/**` matched no filter at all, so a pull request editing
//      privacy.html or the consent markup — pages `consent.spec.ts` and
//      `a11y.spec.ts` drive directly — ran no job whatsoever.
//
// Each was found by hand, after the fact. This asserts the invariant instead:
// if a filter says an area changed, the jobs covering that area must have
// actually run. Read the results from `needs.*.result` in ci.yml.
//
// Run locally against a fabricated scenario:
//   CHANGED=web JOBS='lint=success,typecheck=skipped' node tools/ci/assert-coverage.mjs

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Which jobs must run when a given area changes. Mirrors the `if:` conditions
// in ci.yml; if you widen one there, widen it here or this will fail loudly —
// which is the intended failure, not a nuisance.
export const REQUIRED = {
  web: ["lint", "typecheck", "test-web", "build-web", "e2e"],
  // `build-web` and `e2e` are issue #147. `test-web`'s filter had no `api`
  // clause, `build-web` inherits that filter by having no condition of its
  // own, and `e2e` requires `build-web.result == 'success'` — so an api-only
  // pull request skipped the end-to-end suite and this file said nothing,
  // because `REQUIRED.api` did not ask for it either. Failure number five of
  // the kind this file exists to catch, and the first one it was in a position
  // to catch and did not.
  //
  // `test-web` is deliberately *not* required here even though the fix in
  // ci.yml makes it run: what an api change genuinely needs is the Worker
  // driven end to end, and requiring the web unit tests as well would pin one
  // particular way of arranging the gating. Moving the condition onto
  // `build-web` later should not fail this file.
  api: ["lint", "typecheck", "test-api", "build-web", "e2e"],
  packages: ["lint", "typecheck", "test-packages", "test-api", "test-web"],
  // `test-tools` runs tools/preflight's own suite. Before it existed nothing
  // matched `tools/*` — `test-packages` filters on `./packages/*` — so the 55
  // tests that prove each preflight check can still fail had never run. That
  // is failure number four of the kind this file exists to catch.
  tools: ["lint", "typecheck", "test-tools", "test-web"],
  site: ["test-web", "build-web", "e2e"],
  root: ["lint", "typecheck", "test-packages", "test-tools", "test-api", "test-web"],
  docs: [],
};

function parse(env) {
  const changed = (env.CHANGED ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const jobs = Object.fromEntries(
    (env.JOBS ?? "")
      .split(",")
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const i = pair.indexOf("=");
        return [pair.slice(0, i).trim(), pair.slice(i + 1).trim()];
      }),
  );
  return { changed, jobs };
}

export function check({ changed, jobs }) {
  const problems = [];

  // A failed or cancelled job is a plain red build. Cancellation counts:
  // `concurrency.cancel-in-progress` can cancel a run mid-flight, and a
  // cancelled job is not evidence of anything.
  for (const [name, result] of Object.entries(jobs)) {
    if (result === "failure") problems.push(`${name} failed`);
    if (result === "cancelled") problems.push(`${name} was cancelled, so it proved nothing`);
  }

  // The real check: every area the diff touched must have had its jobs run.
  for (const area of changed) {
    const required = REQUIRED[area];
    if (required === undefined) {
      problems.push(
        `the filter "${area}" has no entry in REQUIRED — add one to tools/ci/assert-coverage.mjs ` +
          `saying which jobs cover it, or this area can silently go untested`,
      );
      continue;
    }
    for (const job of required) {
      const result = jobs[job];
      if (result === "skipped" || result === undefined || result === "") {
        problems.push(
          `${area} changed but ${job} did not run (${result || "no result"}) — ` +
            `the gating in ci.yml does not cover this area`,
        );
      }
    }
  }
  return problems;
}

// Only when run as a script. `assert-coverage.test.mjs` imports `check` and
// `REQUIRED` from here to compare them against ci.yml's own conditions, and an
// import that reads `process.env` and can `process.exit(1)` would make the
// test suite's outcome depend on whatever `CHANGED` happened to be set to.
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const { changed, jobs } = parse(process.env);
  const problems = check({ changed, jobs });

  if (problems.length > 0) {
    console.error("CI did not run what this diff required:\n");
    for (const p of problems) console.error(`  - ${p}`);
    console.error("\nA skipped job reports as a green check, which is why this guard exists.");
    process.exit(1);
  }

  console.log(
    changed.length === 0
      ? "No source areas changed; nothing required."
      : `Areas changed: ${changed.join(", ")}. Every required job ran.`,
  );
}

// Tests for tools/ci/assert-coverage.mjs — and, more to the point, for the
// gating in .github/workflows/ci.yml that it mirrors.
//
// Issue #147 is why the second half exists. `assert-coverage.mjs` says "if you
// widen an `if:` in ci.yml, widen REQUIRED here or this will fail loudly" —
// true, but only *after* a pull request of the affected shape has already
// merged with jobs silently skipped. That is how an api-only change skipped
// `e2e` for months: the two lists disagreed and nothing compared them.
//
// So `simulateWorkflow` below reads ci.yml itself, works out which jobs a
// given set of changed areas would actually select — including GitHub's rule
// that a job whose `needs` were skipped is skipped too, which is exactly the
// interaction that hid #147 — and the last test asserts that every job
// REQUIRED for an area is a job the workflow really runs for it.
//
// Run with: node --test tools/ci/*.test.mjs   (or `pnpm --filter ./tools/* test`)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { check, REQUIRED } from "./assert-coverage.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CI_YML = path.resolve(HERE, "../../.github/workflows/ci.yml");

// ── check() itself ─────────────────────────────────────────────────────

test("an api-only diff that skipped e2e is a problem (the #147 shape)", () => {
  const problems = check({
    changed: ["api"],
    jobs: {
      lint: "success",
      typecheck: "success",
      "test-api": "success",
      "test-web": "skipped",
      "build-web": "skipped",
      e2e: "skipped",
    },
  });
  assert.ok(
    problems.some((p) => p.includes("api changed but e2e did not run")),
    `expected an e2e complaint, got: ${problems.join(" | ")}`,
  );
});

test("an api-only diff that ran the whole chain is clean", () => {
  const problems = check({
    changed: ["api"],
    jobs: {
      lint: "success",
      typecheck: "success",
      "test-api": "success",
      "test-web": "success",
      "build-web": "success",
      e2e: "success",
    },
  });
  assert.deepEqual(problems, []);
});

test("a failed or cancelled job is a problem on its own", () => {
  assert.ok(check({ changed: [], jobs: { e2e: "failure" } }).some((p) => p.includes("e2e failed")));
  assert.ok(check({ changed: [], jobs: { e2e: "cancelled" } }).some((p) => p.includes("proved nothing")));
});

test("a filter with no REQUIRED entry fails rather than passing silently", () => {
  const problems = check({ changed: ["brand-new-area"], jobs: { lint: "success" } });
  assert.ok(problems.some((p) => p.includes("has no entry in REQUIRED")));
});

// ── the workflow the list mirrors ──────────────────────────────────────

/**
 * The `jobs:` block of ci.yml, as `{ id: { needs, if } }`.
 *
 * Deliberately not a YAML library: `tools/*` is zero-dependency by
 * convention, and this only has to understand two keys at one indent level.
 * Anything it cannot understand throws — a parser that quietly returns an
 * empty map would make every assertion below vacuous, which is the failure
 * mode this whole file is about.
 */
function parseJobs(yamlText) {
  const lines = yamlText.split("\n");
  const jobsStart = lines.findIndex((line) => line === "jobs:");
  assert.notEqual(jobsStart, -1, "ci.yml has no `jobs:` block");

  const jobs = {};
  let current = null;
  for (const line of lines.slice(jobsStart + 1)) {
    const jobHeader = /^ {2}([A-Za-z][\w-]*):\s*$/.exec(line);
    if (jobHeader) {
      current = jobHeader[1];
      jobs[current] = { needs: [], if: null };
      continue;
    }
    if (current === null) continue;
    const needs = /^ {4}needs:\s*\[(.*)\]\s*$/.exec(line);
    if (needs) {
      jobs[current].needs = needs[1].split(",").map((s) => s.trim()).filter(Boolean);
      continue;
    }
    const condition = /^ {4}if:\s*(.*)$/.exec(line);
    if (condition) jobs[current].if = condition[1].trim();
  }
  assert.ok(Object.keys(jobs).length > 5, "parsed suspiciously few jobs out of ci.yml");
  return jobs;
}

/**
 * Evaluates one `if:` expression for a pull request touching `changed`.
 *
 * Understands only the shapes ci.yml actually uses, and **throws on anything
 * else** so that a new kind of condition fails this test rather than being
 * silently treated as true.
 */
function evaluateCondition(expression, { changed, results }) {
  const body = expression.replace(/^\$\{\{/, "").replace(/\}\}$/, "").trim();
  // No parentheses group anything in this file today (only function calls),
  // so `&&` binds tighter than `||` with no nesting to worry about.
  return body.split("||").some((conjunction) =>
    conjunction.split("&&").every((raw) => {
      const term = raw.trim();
      if (term === "always()" || term === "!cancelled()") return true;
      if (term === "github.event_name == 'workflow_dispatch'") return false; // simulating a pull request
      const filter = /^needs\.changes\.outputs\.([a-z]+) == 'true'$/.exec(term);
      if (filter) return changed.includes(filter[1]);
      const jobResult = /^needs\.([\w-]+)\.result (==|!=) '(\w+)'$/.exec(term);
      if (jobResult) {
        const actual = results[jobResult[1]];
        assert.ok(actual !== undefined, `condition references unknown job ${jobResult[1]}`);
        return jobResult[2] === "==" ? actual === jobResult[3] : actual !== jobResult[3];
      }
      throw new Error(`assert-coverage.test.mjs cannot evaluate the ci.yml condition: ${term}`);
    }),
  );
}

/** True when the expression contains a status function, which is what makes
 * GitHub drop its implicit "all needs succeeded" requirement. */
function hasStatusFunction(expression) {
  return /\b(always|cancelled|success|failure)\s*\(\)/.test(expression);
}

/**
 * Which jobs a pull request touching `changed` actually runs, as
 * `{ jobId: "success" | "skipped" }`.
 *
 * The rule that matters here is GitHub's own: a job whose `needs` did not all
 * succeed is skipped, **even if its `if` is true**, unless that `if` uses a
 * status function. `build-web` has no condition at all and needs `test-web`,
 * which is the entire mechanism of #147.
 */
function simulateWorkflow(jobs, changed) {
  const results = {};
  const resolve = (id, stack = []) => {
    if (results[id] !== undefined) return results[id];
    assert.ok(!stack.includes(id), `cycle in ci.yml needs: ${[...stack, id].join(" -> ")}`);
    const job = jobs[id];
    assert.ok(job !== undefined, `ci.yml has no job "${id}"`);

    const needsResults = Object.fromEntries(job.needs.map((need) => [need, resolve(need, [...stack, id])]));
    const allNeedsSucceeded = Object.values(needsResults).every((r) => r === "success");
    const condition = job.if;

    let runs;
    if (condition === null) {
      runs = allNeedsSucceeded;
    } else {
      runs =
        evaluateCondition(condition, { changed, results: { ...results, ...needsResults } }) &&
        (hasStatusFunction(condition) || allNeedsSucceeded);
    }
    results[id] = runs ? "success" : "skipped";
    return results[id];
  };
  for (const id of Object.keys(jobs)) resolve(id);
  return results;
}

test("the simulator agrees with the bug #147 recorded, once the fix is removed", () => {
  // Proof that the simulator can see the failure at all: take the real
  // workflow and drop the `api` clause the fix added to `test-web`'s
  // condition — nothing else — and an api-only change must go back to
  // skipping build-web and e2e. Without this the assertions below could all
  // be passing because the simulator says "everything runs" to everything.
  //
  // Edited on the parsed job rather than on the file's text: the same clause
  // appears in `lint`, `typecheck` and `test-api`, and a text replace hits
  // whichever comes first — knocking `lint` out skips the whole graph for an
  // unrelated reason and proves nothing.
  const jobs = parseJobs(readFileSync(CI_YML, "utf8"));
  const withoutApi = jobs["test-web"].if.replace(" || needs.changes.outputs.api == 'true'", "");
  assert.notEqual(withoutApi, jobs["test-web"].if, "the #147 fix is not on test-web's condition any more");

  const results = simulateWorkflow({ ...jobs, "test-web": { ...jobs["test-web"], if: withoutApi } }, ["api"]);
  assert.equal(results["test-api"], "success", "test-api should be unaffected");
  assert.equal(results["build-web"], "skipped");
  assert.equal(results.e2e, "skipped", "the #147 bug should reappear when its fix is removed");
});

test("every job REQUIRED for an area is a job ci.yml actually runs for it", () => {
  const jobs = parseJobs(readFileSync(CI_YML, "utf8"));
  for (const [area, required] of Object.entries(REQUIRED)) {
    if (required.length === 0) continue;
    const results = simulateWorkflow(jobs, [area]);
    for (const job of required) {
      assert.equal(
        results[job],
        "success",
        `REQUIRED["${area}"] wants ${job}, but ci.yml skips it for a ${area}-only pull request — ` +
          `assert-coverage.mjs would fail that build after the fact; fix the gating in ci.yml`,
      );
    }
  }
});

test("an api-only pull request reaches the end-to-end suite", () => {
  // The issue's own sentence, as an assertion: the one suite that runs the
  // real Worker must run for the one change shape it is best at.
  const results = simulateWorkflow(parseJobs(readFileSync(CI_YML, "utf8")), ["api"]);
  assert.equal(results.e2e, "success");
  assert.equal(results["build-web"], "success");
  assert.equal(results["test-api"], "success");
});

test("a docs-only pull request still runs nothing expensive", () => {
  // The other direction, so widening the filters cannot quietly turn every
  // README typo into a browser run.
  const results = simulateWorkflow(parseJobs(readFileSync(CI_YML, "utf8")), ["docs"]);
  assert.equal(results.e2e, "skipped");
  assert.equal(results["test-api"], "skipped");
  assert.equal(results["test-web"], "skipped");
});

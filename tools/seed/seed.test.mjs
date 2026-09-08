/**
 * The parts of `seed.mjs` that decide something before any request is made:
 * argument parsing, where a run is pointed, what it will and won't post, and
 * what it says when the API refuses. The network path is proven by running it
 * against a real local Worker (docs/runbooks/seed-catalogue.md), not here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { CATALOGUE, REPO_ROOT } from "./catalogue.mjs";
import {
  DEFAULT_OWNER_TOKEN,
  MAX_RETRY_WAIT_SECONDS,
  TIERS,
  classifyFailure,
  describeFailure,
  parseArgs,
  planListings,
  resolveTarget,
  withRetries,
} from "./seed.mjs";

test("parseArgs defaults to a dry-safe local run", () => {
  const args = parseArgs([]);
  assert.equal(args.env, "local");
  assert.equal(args.baseUrl, null);
  assert.equal(
    args.suggest,
    false,
    "the curated aspects are the default; --suggest opts into the vision call",
  );
  assert.equal(args.dryRun, false);
  assert.equal(args.yesProduction, false);
});

test("parseArgs reads the flags a real run uses", () => {
  const args = parseArgs([
    "--env",
    "preview",
    "--owner-token",
    "ks_x",
    "--turnstile-token",
    "tok",
    "--only",
    "kettle, quilt",
    "--limit",
    "2",
    "--timeout",
    "10",
    "--suggest",
    "--dry-run",
  ]);
  assert.equal(args.env, "preview");
  assert.equal(args.ownerToken, "ks_x");
  assert.equal(args.turnstileToken, "tok");
  assert.deepEqual(args.only, ["kettle", "quilt"]);
  assert.equal(args.limit, 2);
  assert.equal(args.timeoutMs, 10_000);
  assert.equal(args.suggest, true);
  assert.equal(args.dryRun, true);
});

test("parseArgs refuses a typo rather than silently ignoring it", () => {
  assert.throws(() => parseArgs(["--enviroment", "preview"]), /unknown flag/);
  assert.throws(() => parseArgs(["--env"]), /--env needs a value/);
  assert.throws(() => parseArgs(["--limit", "0"]), /positive integer/);
  assert.throws(() => parseArgs(["--limit", "two"]), /positive integer/);
  assert.throws(() => parseArgs(["--timeout", "-1"]), /positive number/);
});

test("resolveTarget maps a tier to its base URL and the committed seed token", () => {
  const target = resolveTarget(parseArgs(["--env", "local"]));
  assert.equal(target.baseUrl, TIERS.local);
  assert.equal(target.ownerToken, DEFAULT_OWNER_TOKEN);
  assert.equal(target.isProduction, false);
});

test("resolveTarget trims a trailing slash so paths never double up", () => {
  const target = resolveTarget(parseArgs(["--base-url", "http://localhost:8787/"]));
  assert.equal(target.baseUrl, "http://localhost:8787");
});

test("resolveTarget rejects an unknown tier and a non-URL base", () => {
  assert.throws(() => resolveTarget(parseArgs(["--env", "staging"])), /unknown --env/);
  assert.throws(() => resolveTarget(parseArgs(["--base-url", "not a url"])), /is not a URL/);
});

test("production is refused without --yes-production, by host and not by the --env word", () => {
  assert.throws(
    () => resolveTarget(parseArgs(["--env", "production"])),
    /refusing to seed keepsake\.ing/,
  );
  // The guard has to survive someone spelling the target a different way.
  assert.throws(
    () => resolveTarget(parseArgs(["--base-url", "https://keepsake.ing"])),
    /refusing to seed keepsake\.ing/,
  );
  assert.throws(
    () => resolveTarget(parseArgs(["--base-url", "https://keepsake.ing/"])),
    /refusing to seed keepsake\.ing/,
  );
});

test("production is still refused under the committed owner token", () => {
  assert.throws(
    () => resolveTarget(parseArgs(["--env", "production", "--yes-production"])),
    /committed seed owner token/,
  );
  const target = resolveTarget(
    parseArgs(["--env", "production", "--yes-production", "--owner-token", "ks_mine"]),
  );
  assert.equal(target.isProduction, true);
  assert.equal(target.ownerToken, "ks_mine");
});

test("preview needs neither flag — it is a tier for looking at", () => {
  const target = resolveTarget(parseArgs(["--env", "preview"]));
  assert.equal(target.baseUrl, TIERS.preview);
  assert.equal(target.isProduction, false);
});

test("the default owner token is one the API's OwnerTokenSchema accepts", () => {
  const source = readFileSync(
    path.join(REPO_ROOT, "packages", "contracts", "src", "owner.ts"),
    "utf8",
  );
  const match = source.match(/regex\(new RegExp\(`\^\$\{OWNER_TOKEN_PREFIX\}(.+?)\$`\)/);
  assert.ok(match, "could not read OwnerTokenSchema's pattern");
  assert.match(DEFAULT_OWNER_TOKEN, new RegExp(`^ks_${match[1]}$`));
});

test("planListings posts the whole catalogue against an empty tier", () => {
  const plan = planListings({ existing: new Map() });
  assert.equal(plan.create.length, CATALOGUE.length);
  assert.deepEqual(plan.skip, []);
});

test("planListings skips a title the tier already carries, whatever its status", () => {
  const existing = new Map([
    [CATALOGUE[0].title, { id: "01ABC", status: "approved" }],
    [CATALOGUE[1].title, { id: "01DEF", status: "needs_review" }],
  ]);
  const plan = planListings({ existing });
  assert.equal(plan.create.length, CATALOGUE.length - 2);
  assert.deepEqual(
    plan.skip.map((s) => s.status),
    ["approved", "needs_review"],
  );
  assert.equal(plan.skip[0].id, "01ABC");
});

test("planListings honours --only and --limit, and names an --only key that does not exist", () => {
  const only = planListings({ only: ["quilt", "kettle"] });
  assert.deepEqual(
    only.create.map((l) => l.key),
    ["kettle", "quilt"], // catalogue order, not argument order
  );

  const limited = planListings({ limit: 2 });
  assert.equal(limited.create.length, 2);
  assert.equal(limited.skip.length, CATALOGUE.length - 2);
  assert.equal(limited.skip[0].status, "over --limit");

  assert.throws(() => planListings({ only: ["teapot"] }), /teapot/);
});

test("a Turnstile refusal is explained, not retried", () => {
  const message = describeFailure(403, {
    ok: false,
    error: { code: "turnstile_failed", message: "Verification failed" },
  });
  assert.match(message, /TURNSTILE_SECRET is set/);
  assert.match(message, /--turnstile-token/);
});

test("the other refusals a run actually hits say what to do about them", () => {
  assert.match(describeFailure(401, {}), /owner token/);
  assert.match(
    describeFailure(429, { error: { code: "rate_limited" } }),
    /LISTING_IP_DAILY_BUDGET is 20/,
  );
  assert.match(
    describeFailure(400, {
      error: { code: "bad_request", message: "We don't know that postcode yet." },
    }),
    /02144/,
  );
  assert.equal(
    describeFailure(500, { error: { code: "internal", message: "boom" } }),
    "500 internal: boom",
  );
  assert.equal(describeFailure(502, null), "502 ");
});

test("a burst 429 is worth waiting out; a daily ceiling is not", () => {
  // `burst()` in apps/api/src/middleware/rateLimit.ts: 60s, per minute.
  const burst = classifyFailure(429, {
    error: {
      code: "rate_limited",
      message: "Too many requests — please slow down.",
      retryAfter: 60,
    },
  });
  assert.deepEqual(burst, { retryable: true, retryAfterSeconds: 60 });

  // `dailyBudget()`: same code and status, `retryAfter` measured in hours.
  const daily = classifyFailure(429, {
    error: {
      code: "rate_limited",
      message: "Daily limit reached — please try again tomorrow.",
      retryAfter: 41_000,
    },
  });
  assert.equal(daily.retryable, false);

  // A long wait is refused even without the daily wording.
  assert.equal(
    classifyFailure(429, { error: { retryAfter: MAX_RETRY_WAIT_SECONDS + 1 } }).retryable,
    false,
  );
  assert.equal(classifyFailure(429, { error: { retryAfter: "soon" } }).retryable, false);
  // Nothing else is ever retried: a 403 or a 400 means the same thing twice.
  assert.equal(classifyFailure(403, { error: { code: "turnstile_failed" } }).retryable, false);
});

test("withRetries waits out a retryable failure and gives up on the rest", async () => {
  const waits = [];
  const sleepSeconds = (seconds) => {
    waits.push(seconds);
    return Promise.resolve();
  };

  let calls = 0;
  const flaky = () => {
    calls += 1;
    if (calls < 3)
      return Promise.reject(
        Object.assign(new Error("429"), { retryable: true, retryAfterSeconds: 60 }),
      );
    return Promise.resolve("posted");
  };
  assert.equal(await withRetries(flaky, { sleepSeconds }), "posted");
  assert.deepEqual(waits, [60, 60]);

  // Never retried: no `retryable` flag.
  let hardCalls = 0;
  const hard = () => {
    hardCalls += 1;
    return Promise.reject(new Error("403 turnstile_failed"));
  };
  await assert.rejects(() => withRetries(hard, { sleepSeconds }), /turnstile_failed/);
  assert.equal(hardCalls, 1);

  // Retryable, but never recovers: the last failure is what surfaces.
  const never = () =>
    Promise.reject(
      Object.assign(new Error("still 429"), { retryable: true, retryAfterSeconds: 1 }),
    );
  await assert.rejects(() => withRetries(never, { attempts: 2, sleepSeconds }), /still 429/);
});

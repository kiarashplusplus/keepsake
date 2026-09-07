#!/usr/bin/env node
// Issue #66: preview is one shared Worker that every open pull request deploys
// to. `deploy.yml`'s own "Verify /health reports this commit" step is correct
// the moment it runs — it is worthless a minute later, because another
// session's deploy can land in the gap between that step and whatever a human
// or agent does next. That happened for real while verifying #14: a probe ran
// 90 seconds after an unrelated branch redeployed over it, and would have
// silently "confirmed" the wrong build if the endpoint under test hadn't
// 404'd.
//
// This script does not close the race — nothing running after the fact can.
// It turns a silent wrong answer into a loud one, by checking `/health`'s
// `commit` field immediately before AND immediately after whatever manual or
// scripted verification you're about to trust, and failing hard if either
// check doesn't match, or if the two checks disagree with each other (which
// means preview moved out from under you mid-verification, even if by luck it
// happened to match going in).
//
// Usage:
//   node tools/ci/verify-preview-commit.mjs <url> <expected-sha>
//       Single check. Exits 0 if <url>/health reports <expected-sha>, 1
//       otherwise. This is the minimum bar: run it right before you look at
//       anything on preview and trust nothing if it fails.
//
//   node tools/ci/verify-preview-commit.mjs <url> <expected-sha> -- <cmd> [args...]
//       Wraps <cmd>. Checks before running it and again after it exits.
//       Fails (regardless of <cmd>'s own exit code) if either check doesn't
//       match <expected-sha>, printing which side drifted. This is the form
//       to use around anything that takes more than an instant — curling an
//       endpoint, running a Playwright spec by hand, clicking through the
//       product — because the single-check form only proves the truth at one
//       instant and the whole point of #66 is that this changes underneath
//       you between instants.
//
// <expected-sha> may be a full 40-char commit or any non-empty prefix of one
// (`/health` always reports the full sha CI stamped it with; short forms are
// accepted so this is comfortable to run by hand against `git rev-parse
// --short HEAD`).
//
// Exit codes: 0 = verified, 1 = mismatch or drift, 2 = usage/network error.

function usageError(message) {
  console.error(`::error::${message}`);
  console.error(
    "usage: verify-preview-commit.mjs <url> <expected-sha> [-- <command> [args...]]",
  );
  process.exit(2);
}

async function fetchCommit(url) {
  const healthUrl = `${url.replace(/\/+$/, "")}/health`;
  let body;
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(10_000) });
    body = await res.text();
    if (!res.ok) {
      console.error(`::error::${healthUrl} returned HTTP ${res.status}: ${body}`);
      process.exit(2);
    }
  } catch (err) {
    console.error(`::error::could not reach ${healthUrl}: ${err.message}`);
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    console.error(`::error::${healthUrl} did not return JSON: ${body}`);
    process.exit(2);
  }
  const commit = parsed.commit;
  if (!commit || typeof commit !== "string") {
    console.error(`::error::${healthUrl} response had no .commit field: ${body}`);
    process.exit(2);
  }
  return { commit, body };
}

function matches(commit, expected) {
  return commit === expected || commit.startsWith(expected);
}

async function check(url, expected, label) {
  const { commit, body } = await fetchCommit(url);
  if (!matches(commit, expected)) {
    console.error(
      `::error::${label}: ${url}/health reports commit "${commit}", expected "${expected}". ` +
        `Someone else's deploy is on preview right now — treat anything you observe as UNVERIFIED, not just this check.`,
    );
    console.error(body);
    return { ok: false, commit };
  }
  console.log(`${label}: ${url}/health matches "${expected}" (full: ${commit})`);
  console.log(body);
  return { ok: true, commit };
}

async function main() {
  const args = process.argv.slice(2);
  const sepIndex = args.indexOf("--");
  const positional = sepIndex === -1 ? args : args.slice(0, sepIndex);
  const command = sepIndex === -1 ? null : args.slice(sepIndex + 1);

  const [url, expected] = positional;
  if (!url || !expected) {
    usageError("both <url> and <expected-sha> are required");
  }
  if (command !== null && command.length === 0) {
    usageError("-- was given but no command followed it");
  }

  const before = await check(url, expected, "pre-check");
  if (!before.ok) {
    process.exit(1);
  }

  if (!command) {
    process.exit(0);
  }

  console.log(`running: ${command.join(" ")}`);
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(command[0], command.slice(1), {
    stdio: "inherit",
    shell: false,
  });

  const after = await check(url, expected, "post-check");
  if (!after.ok) {
    console.error(
      "::error::preview served a different commit AFTER your command ran than before it started. " +
        "Whatever you just observed may belong to someone else's deploy, not this one. Re-run your verification once preview is stable, or use per-branch evidence (deploy.yml's own logs) instead of the shared Worker.",
    );
    process.exit(1);
  }
  if (before.commit !== after.commit) {
    // Both matched `expected` (by prefix) but weren't byte-identical, which
    // can only happen with a prefix match against two different full shas
    // that happen to share that prefix — vanishingly unlikely, but the whole
    // premise of this script is not trusting unlikely-but-unverified.
    console.error(
      `::error::pre-check and post-check both matched the expected prefix but resolved to different commits (${before.commit} vs ${after.commit}). Use the full 40-char sha to remove the ambiguity.`,
    );
    process.exit(1);
  }

  console.log("pre-check and post-check agree: preview did not move during verification.");
  process.exit(result.status ?? 1);
}

main();

#!/usr/bin/env node
/**
 * Posts a small browsable catalogue of keepsakes through the real public API,
 * so a tier that nobody has given anything to yet has something to browse.
 *
 * Usage:
 *   node tools/seed/seed.mjs --env local
 *   node tools/seed/seed.mjs --env local --dry-run
 *   node tools/seed/seed.mjs --base-url http://localhost:8787 --only kettle,quilt
 *
 * ## Read this before reaching for it: Turnstile decides where this works
 *
 * `POST /api/listings` mounts `turnstile()` (`apps/api/src/routes/listings.ts`).
 * That middleware passes everything through only while `TURNSTILE_SECRET` is
 * unset; once the secret exists it is enforced unconditionally and a request
 * with no `cf-turnstile-response` header is a flat 403 `turnstile_failed`.
 *
 * The secret is set on **preview and production** (`docs/runbooks/
 * kiarash-checklist.md` §2, verified 2026-09-06: a request with no token and a
 * request with a bogus token are both refused). So:
 *
 *   - **local / any Worker with no `TURNSTILE_SECRET`** — the whole catalogue
 *     seeds unattended. This is what the tool is for.
 *   - **preview / production** — a token is required, one per listing. A
 *     Turnstile token is single-use and expires after 300 seconds, so
 *     `--turnstile-token` seeds exactly one keepsake per solved challenge, and
 *     the widget only issues tokens on `keepsake.ing`/`preview.keepsake.ing`
 *     pages, i.e. from the give flow itself. There is no headless path here,
 *     and this tool does not pretend otherwise or try to work around the
 *     challenge: on a 403 it says so and stops.
 *
 * What would change that is a decision, not a workaround: an
 * admin-authenticated create route (`/api/admin/*` already approves, hides,
 * bans and reads requesters' contact details, so it is the existing trust
 * boundary for "the operator, not a stranger"). Nobody has asked for one, so
 * it does not exist.
 *
 * ## The honesty rule
 *
 * Every listing here is a photograph of an object that is not in anyone's
 * house. A stranger who taps "I'd love this" on one expects to be handed the
 * thing by a person. That is fine on a tier meant for looking at (local,
 * preview) and it is a lie on `keepsake.ing`, which is why `--env production`
 * refuses to run without `--yes-production` *and* an explicit `--owner-token`.
 * Fill production with objects that exist and that someone will actually hand
 * over — posted through the give flow, which is also the only path Turnstile
 * leaves open there.
 *
 * Seeded listings deliberately carry **no email address**: nothing here should
 * put a fabricated giver's address into `owners`, and a demo listing that
 * mails somebody when a stranger asks for it is worse than one that doesn't.
 * Requests on them are visible in `/mine` (with the seed owner token) and in
 * the admin queue, and nowhere else.
 *
 * ## What a run does per keepsake
 *
 *   1. `PUT /api/photos` — the real photograph and its thumbnail, with the
 *      width/height/blurhash `catalogue.mjs` measured against those bytes.
 *   2. `POST /api/photos/:id/suggest`, but **only under `--suggest`**. The
 *      catalogue carries hand-written aspects, and they are better than what
 *      this call returns for two reasons: a curated one is right about the
 *      object in the photograph, and under `MOCK_AI=1` — i.e. every local
 *      stack — `suggest.ts` returns a *canned* suggestion, so a first run of
 *      this tool labelled a cut-glass dish `object: mug, material: ceramic,
 *      colour: blue`. `--suggest` is there for exercising the real vision
 *      call against a tier that has one; it spends `SUGGEST_DAILY_BUDGET`,
 *      and a failure is a warning that falls back to the curated aspects.
 *   3. `POST /api/listings` — with a deterministic `X-Idempotency-Key`, so a
 *      re-run inside 24h replays the first response instead of posting a
 *      second copy.
 *   4. Polls `GET /api/listings/:id`, which answers 200 only for
 *      `approved`/`given`, until moderation publishes it. A listing held for a
 *      human (`needs_review`) is reported as exactly that, with its reason,
 *      rather than counted as seeded.
 *
 * Re-runs are idempotent beyond the 24h idempotency window too: the run starts
 * by reading `GET /api/me/listings` under the seed owner token and skips every
 * title already there.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOGUE, DEFAULT_PHOTO_DIR, loadPhotoSet, photoSetProblems } from "./catalogue.mjs";

export const TIERS = {
  local: "http://localhost:8787",
  preview: "https://preview.keepsake.ing",
  production: "https://keepsake.ing",
};

/**
 * One fixed device identity for the whole catalogue, so the seeded keepsakes
 * belong to one giver (a person clearing out a house, which is what the feed
 * should look like) and so a re-run can find its own work. Matches
 * `OwnerTokenSchema`: `ks_` + exactly 43 base64url characters.
 *
 * It is committed, so anyone reading this repo can edit or delete anything it
 * posts. That is acceptable for a tier meant for looking at and is not
 * acceptable for production, which is one of the two reasons `--env
 * production` demands an explicit `--owner-token`.
 */
export const DEFAULT_OWNER_TOKEN = `ks_${"keepsakeseedcatalogue".padEnd(43, "0")}`;

/** Only the age gate's presence is recorded server-side, never the date
 * itself (`apps/api/src/routes/listings.ts`, issue #64). */
const SEED_DATE_OF_BIRTH = "1990-01-01";

const HELP = `Seed a browsable demo catalogue through the real public API.

  --env <local|preview|production>   Which tier (default: local)
  --base-url <url>                   Override the tier's base URL
  --owner-token <ks_...>             Device identity to post as
                                     (default: the committed seed token)
  --turnstile-token <token>          A solved Turnstile token. Single-use and
                                     good for 300s, so it seeds one keepsake.
  --photos <dir>                     Photo directory (needs manifest.json);
                                     default: apps/web/e2e/fixtures/photos
  --only <key,key>                   Seed just these catalogue keys
  --limit <n>                        Seed at most n keepsakes
  --suggest                          Ask the vision model for aspects instead
                                     of using the curated ones (canned under
                                     MOCK_AI, so not for a local stack)
  --timeout <seconds>                How long to wait for moderation (default 45)
  --dry-run                          Say what would be posted, post nothing
  --yes-production                   Required to touch keepsake.ing. Read the
                                     honesty rule at the top of this file first.
  -h, --help                         This.
`;

export function parseArgs(argv) {
  const args = {
    env: "local",
    baseUrl: null,
    ownerToken: null,
    turnstileToken: null,
    photoDir: null,
    only: null,
    limit: null,
    suggest: false,
    timeoutMs: 45_000,
    dryRun: false,
    yesProduction: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };

    switch (flag) {
      case "--env":
        args.env = value();
        break;
      case "--base-url":
        args.baseUrl = value();
        break;
      case "--owner-token":
        args.ownerToken = value();
        break;
      case "--turnstile-token":
        args.turnstileToken = value();
        break;
      case "--photos":
        args.photoDir = path.resolve(value());
        break;
      case "--only":
        args.only = value()
          .split(",")
          .map((key) => key.trim())
          .filter(Boolean);
        break;
      case "--limit": {
        const raw = value();
        const limit = Number(raw);
        if (!Number.isInteger(limit) || limit < 1)
          throw new Error(`--limit needs a positive integer, got "${raw}"`);
        args.limit = limit;
        break;
      }
      case "--timeout": {
        const raw = value();
        const seconds = Number(raw);
        if (!Number.isFinite(seconds) || seconds <= 0)
          throw new Error(`--timeout needs a positive number, got "${raw}"`);
        args.timeoutMs = Math.round(seconds * 1000);
        break;
      }
      case "--suggest":
        args.suggest = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--yes-production":
        args.yesProduction = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`unknown flag "${flag}" — run with --help`);
    }
  }

  return args;
}

/**
 * Where this run will post, and as whom.
 *
 * The production guard keys off the resolved **host**, not the `--env` word,
 * so `--base-url https://keepsake.ing` is guarded exactly as `--env
 * production` is. A guard that can be walked around by spelling the target
 * differently is not a guard.
 */
export function resolveTarget(args) {
  const baseUrl = (args.baseUrl ?? TIERS[args.env] ?? "").replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error(
      `unknown --env "${args.env}" — one of ${Object.keys(TIERS).join(", ")}, or pass --base-url`,
    );
  }

  let host;
  try {
    host = new URL(baseUrl).host;
  } catch {
    throw new Error(`--base-url "${args.baseUrl}" is not a URL`);
  }

  const isProduction = host === new URL(TIERS.production).host;
  if (isProduction && !args.yesProduction) {
    throw new Error(
      "refusing to seed keepsake.ing: these listings are photographs of objects nobody owns, and a " +
        "stranger who asks for one expects to be handed it. Fill production through the give flow " +
        "with real objects. If you have read the honesty rule in seed.mjs and still mean it, pass " +
        "--yes-production.",
    );
  }

  const ownerToken = args.ownerToken ?? DEFAULT_OWNER_TOKEN;
  if (isProduction && !args.ownerToken) {
    throw new Error(
      "refusing to seed keepsake.ing under the committed seed owner token: it is in this repo, so " +
        "anyone who reads it could edit or delete those listings. Pass --owner-token with a token " +
        "you generated and kept.",
    );
  }

  return { baseUrl, host, isProduction, ownerToken };
}

/** What to post and what is already there. `existing` is title -> row. */
export function planListings({
  catalogue = CATALOGUE,
  existing = new Map(),
  only = null,
  limit = null,
} = {}) {
  let wanted = catalogue;

  if (only) {
    const keys = new Set(only);
    const unknown = only.filter((key) => !catalogue.some((listing) => listing.key === key));
    if (unknown.length > 0) {
      throw new Error(
        `--only names ${unknown.join(", ")}, which ${unknown.length === 1 ? "is" : "are"} not in the catalogue`,
      );
    }
    wanted = catalogue.filter((listing) => keys.has(listing.key));
  }

  const create = [];
  const skip = [];
  for (const listing of wanted) {
    const already = existing.get(listing.title);
    if (already) skip.push({ listing, status: already.status, id: already.id });
    else if (limit !== null && create.length >= limit)
      skip.push({ listing, status: "over --limit", id: null });
    else create.push(listing);
  }

  return { create, skip };
}

/**
 * Longest pause this tool will take on a 429 before giving up on a step. The
 * burst brake's `retryAfter` is 60s; a daily budget's is however long is left
 * until midnight UTC, which is not something to sit through.
 */
export const MAX_RETRY_WAIT_SECONDS = 120;

/**
 * Which 429s are worth waiting out.
 *
 * Measured, not assumed: a first run of this tool against a local Worker
 * posted five keepsakes and then took a 429 on the sixth. That is `RL_CREATE`,
 * the `[[ratelimits]]` binding configured at 5 per 60 seconds, doing exactly
 * its job — the e2e suite never sees it because `e2e/support/api.ts` gives
 * every helper a fresh `CF-Connecting-IP`, which is a local-only trick (on a
 * real tier Cloudflare's edge sets that header and a client cannot). A seeding
 * run genuinely is one address posting several listings in a row, so the
 * honest answer is to wait for the window rather than to look like several
 * addresses.
 *
 * The *daily* ceiling (`LISTING_IP_DAILY_BUDGET`, 20/address/UTC-day) returns
 * the same 429 with a `retryAfter` measured in hours, and waiting that out is
 * not something a command should do behind your back.
 */
export function classifyFailure(status, body) {
  if (status !== 429) return { retryable: false, retryAfterSeconds: 0 };
  const retryAfterSeconds = Number(body?.error?.retryAfter ?? 60);
  const daily = /daily limit/i.test(body?.error?.message ?? "");
  if (daily || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds > MAX_RETRY_WAIT_SECONDS) {
    return {
      retryable: false,
      retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 0,
    };
  }
  return { retryable: true, retryAfterSeconds };
}

/**
 * Turn a failed write into something the operator can act on. The 403 case is
 * the one that matters: `turnstile_failed` on preview or production is not a
 * bug in this tool and not something to retry.
 */
export function describeFailure(status, body) {
  const code = body?.error?.code ?? "";
  const message = body?.error?.message ?? "";

  if (status === 403 && code === "turnstile_failed") {
    return (
      "403 turnstile_failed — this tier enforces Turnstile (TURNSTILE_SECRET is set), so a listing " +
      "cannot be posted without a solved challenge. A token is single-use and expires in 300s: pass " +
      "one with --turnstile-token to seed a single keepsake, or seed a tier with no secret set. See " +
      "the header of seed.mjs."
    );
  }
  if (status === 401) {
    return "401 — the owner token was refused. Check --owner-token.";
  }
  if (status === 429) {
    return (
      `429 ${code} — ${message || "rate limited"} LISTING_IP_DAILY_BUDGET is 20 per address per UTC ` +
      "day, and it does not reset until midnight UTC. Finish the run tomorrow; keepsakes already " +
      "seeded are skipped."
    );
  }
  if (status === 400 && /postcode/i.test(message)) {
    return (
      `400 — ${message} The postal_codes table has no row for it. A local stack seeds only 02144, ` +
      "02139 and 01608 (apps/web/e2e/support/global-setup.mjs); preview and production carry the full " +
      "GeoNames seed."
    );
  }
  return `${status} ${code}${message ? `: ${message}` : ""}`;
}

const log = (...parts) => console.log("[seed]", ...parts);

async function readEnvelope(response) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    /* a non-JSON body is itself the diagnostic; `describeFailure` handles null */
  }
  return body;
}

class SeedError extends Error {
  constructor(
    message,
    { status = 0, retryable = false, retryAfterSeconds = 0, turnstile = false } = {},
  ) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
    this.turnstile = turnstile;
  }
}

async function api(baseUrl, pathname, init = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const body = await readEnvelope(response);
  if (!response.ok || !body?.ok) {
    const { retryable, retryAfterSeconds } = classifyFailure(response.status, body);
    throw new SeedError(describeFailure(response.status, body), {
      status: response.status,
      retryable,
      retryAfterSeconds,
      turnstile: response.status === 403 && body?.error?.code === "turnstile_failed",
    });
  }
  return body.data;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a step, waiting out a burst-brake 429 rather than failing the keepsake.
 * `deps` is injectable so the tests can prove the waiting without doing any.
 */
export async function withRetries(
  step,
  { attempts = 3, sleepSeconds = (s) => sleep(s * 1000), onWait = () => {} } = {},
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await step();
    } catch (err) {
      lastError = err;
      if (!err?.retryable || attempt === attempts) throw err;
      onWait(err.retryAfterSeconds, attempt);
      await sleepSeconds(err.retryAfterSeconds);
    }
  }
  throw lastError;
}

/** title -> { id, status } for everything this owner token has posted. A 401
 * is the honest answer for a token the server has never seen — an empty tier,
 * not an error. */
async function fetchExisting(baseUrl, ownerToken) {
  const response = await fetch(`${baseUrl}/api/me/listings`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  if (response.status === 401) return new Map();
  const body = await readEnvelope(response);
  if (!response.ok || !body?.ok) throw new SeedError(describeFailure(response.status, body));
  return new Map(
    body.data.map((listing) => [listing.title, { id: listing.id, status: listing.status }]),
  );
}

async function uploadPhoto(baseUrl, ownerToken, photo) {
  const form = new FormData();
  form.set(
    "full",
    new File([readFileSync(photo.full)], `${photo.key}.jpg`, { type: "image/jpeg" }),
  );
  form.set(
    "thumb",
    new File([readFileSync(photo.thumb)], `${photo.key}.thumb.jpg`, { type: "image/jpeg" }),
  );
  form.set("width", String(photo.width));
  form.set("height", String(photo.height));
  form.set("blurhash", photo.blurhash);

  const data = await api(baseUrl, "/api/photos", {
    method: "PUT",
    headers: { Authorization: `Bearer ${ownerToken}` },
    body: form,
  });
  return data.id;
}

/** The give flow's vision call, under `--suggest` only. Only `aspects` are
 * kept, and the curated ones stand in when the call fails or says nothing —
 * an aspect-less card is a worse outcome than a hand-written aspect. */
async function suggestAspects(baseUrl, ownerToken, photoId, fallback) {
  try {
    const data = await api(baseUrl, `/api/photos/${photoId}/suggest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const aspects = data?.suggestion?.aspects ?? [];
    return aspects.length > 0 ? aspects : fallback;
  } catch (err) {
    log(`  suggestion failed, keeping the curated aspects (${err.message})`);
    return fallback;
  }
}

async function createListing(baseUrl, { ownerToken, turnstileToken, listing, photoId, aspects }) {
  const headers = {
    Authorization: `Bearer ${ownerToken}`,
    "Content-Type": "application/json",
    // Deterministic per keepsake, per owner: a re-run inside the 24h window
    // replays the first response rather than posting a second copy — which is
    // also what makes the rate-limit retry above safe to do on a create.
    "X-Idempotency-Key": `seed-catalogue-${listing.key}`,
  };
  if (turnstileToken) headers["cf-turnstile-response"] = turnstileToken;

  return api(baseUrl, "/api/listings", {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: listing.title,
      story: listing.story,
      category: listing.category,
      country: "US",
      postal_code: listing.postalCode,
      photo_ids: [photoId],
      date_of_birth: SEED_DATE_OF_BIRTH,
      aspects,
    }),
  });
}

/**
 * `POST /api/listings` returns while `moderateListing()` is still running in
 * `waitUntil()`, and `GET /api/listings/:id` answers 200 only once the listing
 * is `approved`/`given` — so polling it is the honest way to watch moderation
 * finish. On a timeout, the owner-side row says what actually happened.
 */
async function waitForPublication(baseUrl, ownerToken, id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/listings/${id}`);
    if (response.status === 200) return { published: true };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const response = await fetch(`${baseUrl}/api/me/listings/${id}`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  const body = await readEnvelope(response);
  const row = body?.ok ? body.data : null;
  return {
    published: false,
    status: row?.status ?? "unknown",
    reason: row?.moderation_reason ?? null,
  };
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`[seed] ${err.message}`);
    return 2;
  }

  if (args.help) {
    console.log(HELP);
    return 0;
  }

  let target;
  try {
    target = resolveTarget(args);
  } catch (err) {
    console.error(`[seed] ${err.message}`);
    return 2;
  }

  const photoDir = args.photoDir ?? DEFAULT_PHOTO_DIR;
  const photos = loadPhotoSet(photoDir);
  const problems = photoSetProblems(CATALOGUE, photos);
  if (problems.length > 0) {
    console.error(`[seed] photo set at ${photoDir} is unusable:`);
    for (const problem of problems) console.error(`[seed]   ${problem}`);
    return 2;
  }

  log(`target ${target.baseUrl}`);
  if (target.isProduction) {
    log(
      "this is the live site. Seeded listings are objects nobody owns — see the honesty rule in seed.mjs.",
    );
  }

  let existing;
  try {
    existing = await fetchExisting(target.baseUrl, target.ownerToken);
  } catch (err) {
    console.error(`[seed] could not read ${target.baseUrl}/api/me/listings — ${err.message}`);
    return 1;
  }

  let plan;
  try {
    plan = planListings({ existing, only: args.only, limit: args.limit });
  } catch (err) {
    console.error(`[seed] ${err.message}`);
    return 2;
  }

  for (const skipped of plan.skip) {
    log(
      `skip  ${skipped.listing.key} — already ${skipped.status}${skipped.id ? ` (${skipped.id})` : ""}`,
    );
  }

  if (args.dryRun) {
    for (const listing of plan.create)
      log(`would post  ${listing.key} — "${listing.title}" (${listing.postalCode})`);
    log(`dry run: ${plan.create.length} to post, ${plan.skip.length} skipped`);
    return 0;
  }

  if (plan.create.length > 1 && args.turnstileToken) {
    log("note: a Turnstile token is single-use, so only the first keepsake below can use it.");
  }

  const posted = [];
  const held = [];
  const failed = [];

  for (const listing of plan.create) {
    log(`post  ${listing.key} — "${listing.title}"`);
    const waiting = (seconds) =>
      log(`  rate limited, waiting ${seconds}s for the window to reopen`);
    try {
      const photoId = await withRetries(
        () => uploadPhoto(target.baseUrl, target.ownerToken, photos[listing.key]),
        {
          onWait: waiting,
        },
      );
      const curated = listing.aspects ?? [];
      const aspects = args.suggest
        ? await suggestAspects(target.baseUrl, target.ownerToken, photoId, curated)
        : curated;
      const created = await withRetries(
        () =>
          createListing(target.baseUrl, {
            ownerToken: target.ownerToken,
            turnstileToken: args.turnstileToken,
            listing,
            photoId,
            aspects,
          }),
        { onWait: waiting },
      );

      const outcome = await waitForPublication(
        target.baseUrl,
        target.ownerToken,
        created.id,
        args.timeoutMs,
      );
      if (outcome.published) {
        posted.push(listing.key);
        log(`  approved ${created.id}${aspects.length ? ` (${aspects.length} aspects)` : ""}`);
      } else {
        held.push({ key: listing.key, id: created.id, ...outcome });
        log(`  ${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""} — ${created.id}`);
      }
    } catch (err) {
      failed.push({ key: listing.key, message: err.message });
      log(`  failed — ${err.message}`);
      // A Turnstile wall or a spent daily budget will fail every remaining
      // keepsake in exactly the same way; there is nothing to learn from
      // seven identical 403s. A burst 429 is different — it was already
      // waited out above, and reaching here means the window never reopened.
      if (err instanceof SeedError && (err.turnstile || err.status === 429)) {
        log("  stopping: every remaining keepsake would fail the same way.");
        break;
      }
    }
  }

  log(
    `done — ${posted.length} approved, ${held.length} held for review, ${failed.length} failed, ` +
      `${plan.skip.length} already there`,
  );
  if (held.length > 0) {
    log(
      `held listings are invisible until a human approves them at ${target.baseUrl}/admin (Queue).`,
    );
  }
  return failed.length > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}

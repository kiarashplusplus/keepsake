# Seeding a demo catalogue

`tools/seed/seed.mjs` posts seven keepsakes — real photographs, written stories,
hand-written aspects, three postcodes — through the same public API a giver's
browser uses. It exists so a tier nobody has given anything to has something to
browse.

```sh
node tools/seed/seed.mjs --env local --dry-run   # say what it would post
node tools/seed/seed.mjs --env local             # post it
node tools/seed/seed.mjs --help
```

## Where it works, and where it does not

**Turnstile decides this, not the tool.** `POST /api/listings` mounts
`turnstile()`, which passes everything through only while `TURNSTILE_SECRET` is
unset. The secret is set on **preview and production**
([kiarash-checklist.md](./kiarash-checklist.md) §2, verified 2026-09-06), so on
those tiers a listing cannot be posted without a solved challenge.

| Tier                              | Result                                                        |
| --------------------------------- | ------------------------------------------------------------- |
| local (`wrangler dev`, no secret) | the whole catalogue seeds unattended                          |
| preview                           | 403 `turnstile_failed` — one keepsake per `--turnstile-token` |
| production                        | same, plus two deliberate guards (below)                      |

A Turnstile token is single-use and expires after 300 seconds, and the widget
only issues one on a `keepsake.ing` / `preview.keepsake.ing` page — i.e. from
the give flow itself. **So there is no unattended path to preview or production
today**, and this tool does not pretend otherwise: on a 403 it explains and
stops rather than retrying or working around the challenge.

What would change that is a decision rather than a workaround: an
admin-authenticated create route. `/api/admin/*` already approves listings,
hides them, bans owners and reads requesters' contact details, so it is the
existing "the operator, not a stranger" boundary — but nobody has asked for it,
so it does not exist.

## The honesty rule

Everything in this catalogue is a photograph of an object that is in nobody's
house. A stranger who taps "I'd love this" expects a person to hand them the
thing.

That is fine on a tier meant for looking at. On `keepsake.ing` it is a lie, so
`--env production` refuses to run twice over: once without `--yes-production`,
and again unless you pass your own `--owner-token` (the default seed token is
committed in this repo, so anyone reading it could edit or delete listings
posted under it). The guard keys off the resolved **host**, so
`--base-url https://keepsake.ing` is refused exactly as `--env production` is.

Fill production through the give flow, with objects that exist — which is also
the only path Turnstile leaves open there, and what #47 asks for.

Seeded listings carry **no email address** on purpose. Nothing here should put
a fabricated giver's address into `owners`, and a demo listing that emails
somebody when a stranger asks for it is worse than one that doesn't. Requests
on a seeded listing are visible in `/mine` (with the seed owner token) and in
the admin queue, and nowhere else.

## Running it against a local stack

The stack the e2e suite uses, which needs no GeoNames seed and no AI credential:

```sh
pnpm --filter @keepsake/web export           # the Worker serves dist/ via [assets]
node apps/web/e2e/support/global-setup.mjs   # wipes .wrangler/e2e-state, migrates, seeds 3 postcodes
cd apps/api && pnpm exec wrangler dev --local --port 8787 \
  --persist-to .wrangler/e2e-state --env-file .wrangler/e2e-state/e2e.env \
  --var MOCK_AI:1 --var SITE_URL:http://127.0.0.1:8787
# in another shell:
node tools/seed/seed.mjs --env local --base-url http://127.0.0.1:8787
```

A full run takes about a minute, most of it waiting: `RL_CREATE` is 5 requests
per 60 seconds and a seeding run is one address posting seven listings, so the
sixth is rate limited and the tool waits out the window rather than looking
like several addresses. (The e2e suite never sees this because
`e2e/support/api.ts` gives every helper a fresh `CF-Connecting-IP` — a
local-only trick: on a real tier Cloudflare's edge sets that header.)

Re-runs are safe. The run reads `GET /api/me/listings` under the seed owner
token first and skips every title already there, and each create carries a
deterministic `X-Idempotency-Key` so even a retry inside 24h replays rather than
posting a second copy.

## Aspects

The catalogue carries hand-written aspects and posts those by default.
`--suggest` asks `POST /api/photos/:id/suggest` instead — the real vision call
the give flow makes — falling back to the curated ones if it fails or returns
nothing. **Do not bother on a local stack**: `MOCK_AI=1` returns a canned
suggestion, and a first run of this tool labelled a cut-glass dish
`object: mug, material: ceramic, colour: blue`.

## Growing the catalogue

It is seven keepsakes because there are seven photographs
(`apps/web/e2e/fixtures/photos`, shared with the UX baseline — the measurements
live in one place and `tools/seed/catalogue.test.mjs` fails if the two copies
drift). Two cards with the same photo read as broken, so more keepsakes means
more photographs first.

To add some: process each image the way that directory's README documents
(1200px long edge at q82, a 400px `<key>.thumb.jpg`, and a blurhash encoded
with the app's own `blurhash` package), then either extend `PHOTOS` and
`CATALOGUE` in `tools/seed/catalogue.mjs`, or keep your own set outside the
repo and point at it:

```sh
node tools/seed/seed.mjs --env local --photos ~/keepsake-photos
```

A `--photos` directory needs a `manifest.json` of
`{ "<key>": { "width": …, "height": …, "blurhash": "…" } }` beside the images —
the API stores those three values rather than decoding the file, and this tool
deliberately carries no image-processing dependency to derive them.

## What a run reports

- `approved` — moderation published it; it is on the feed.
- `needs_review` — held for a human. Invisible until approved in `/admin` →
  Queue. Not counted as seeded.
- `failed` — with the reason, and the run stops early when every remaining
  keepsake would fail identically (a Turnstile wall, a spent daily budget).

Exit code is 1 if anything failed, 0 otherwise.

## Verified

2026-09-08 UTC, against a local `wrangler dev` (real workerd, local D1/R2/KV,
`MOCK_AI=1`), from an empty database:

- 7 posted, 7 `approved`, 0 held, 0 failed; the sixth waited out a `RL_CREATE`
  429 and then succeeded.
- `GET /api/feed` → 7 cards, each with its photograph, place name and three
  aspects; `/i/<id>/full` served the real JPEG (200, `image/jpeg`, 202 KB).
- `?postal=02144&radius_mi=25` → 6 (Somerville 0 mi, Cambridge 1.7 mi);
  `radius_mi=50` → 7, picking up Worcester at 37.2 mi.
- A second run with the database untouched skipped all seven by title.

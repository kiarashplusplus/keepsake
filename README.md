# Keepsake

Keepsake is a public, browsable, free gifting marketplace for sentimental objects. You
photograph a keepsake you're ready to let go of, write its story, and post it — anyone can
browse nearby, filtered by postcode and radius. Someone who loves it taps "I'd love this," leaves
a note and an email, and the giver picks who gets it. No money, no bidding, no accounts.

Identity is a device-bound secret token minted the first time you post, not a signup; an
optional verified email exists only for notifications and recovering your listings if you lose
the device. Every listing is pre-screened by open models before it's public — borderline cases
are held for a human to approve rather than auto-approved or auto-rejected. The identity is
**v3 "Polaroids on a table"**: every listing is an instant-film print taped down at a slight
tilt on a kraft-paper table, and a red rubber stamp is the one accent
([`docs/design/design-system.md`](./docs/design/design-system.md)).

## Stack

- **Web**: Expo SDK 57 + expo-router, static export (`web.output: "static"`) — web only for now;
  iOS/Android are a later flip on the same codebase (see
  [`docs/platform-differences.md`](./docs/platform-differences.md)).
- **API**: Cloudflare Workers (Hono) + D1 + R2 + KV + Workers AI (moderation) + Cloudflare Email
  Service + Turnstile + rate-limit bindings.
- **Data**: Postcode + radius search over **US and Canada**, backed by a GeoNames postal-code
  table bundled straight into D1 — no geocoding API (see
  [`docs/runbooks/geodata.md`](./docs/runbooks/geodata.md)). The seed still carries GB rows and
  the builder still knows the GB rule, but the UK is geo-blocked on purpose
  ([`docs/runbooks/uk-block.md`](./docs/runbooks/uk-block.md)).
- **Tooling**: pnpm workspaces, TypeScript 5.9 strict, ESLint 9 flat config with a barrel-import
  ban (see [`docs/design/README.md#barrel-ban`](./docs/design/README.md#barrel-ban)).

## Layout

```
apps/web/          Expo app: routes (app/), design-system primitives (src/ui/), api client, lib
apps/api/           Cloudflare Worker: routes, moderation pipeline, migrations, seeds (git-lfs)
packages/tokens/    Design tokens — plain TS constants, subpath exports only
packages/contracts/ Zod schemas shared by the API and the web client, subpath exports only
packages/observability/  Workers Logs capture + redaction, subpath exports only
tools/preflight/    Zero-dependency CI checks that don't need a running Worker
tools/geodata/      Builds the bundled postal-code seed from GeoNames
tools/seed/         Posts a demo catalogue through the real API (docs/runbooks/seed-catalogue.md)
tools/readable-test-runner.mjs   Runs every package's tests, non-fail-fast, with a summary table
docs/design/        Status of record for the build (milestones, per-topic docs)
docs/runbooks/      deploy, restore, migrations, admin, incident, geodata, uk-block,
                    uk-reentry-checklist, issue-workflow, launch-audit, kiarash-checklist,
                    verify-production, seed-catalogue
```

## Getting started

```sh
pnpm install
pnpm preflight   # tools/preflight/preflight.mjs — seconds-fast sanity checks
pnpm test        # tools/readable-test-runner.mjs — preflight + every workspace's tests
pnpm web         # apps/web: expo start --web
pnpm api         # apps/api: wrangler dev
```

Copy `.env.example` and fill in real values for local dev (see that file's comments — it
documents every var the Worker and the web export read, and which ones are secrets). `pnpm
preflight`'s `env-parity` check keeps `.env.example` and `apps/api/wrangler.toml` from drifting
apart.

## git-lfs

`apps/api/seeds/*.sql` (the generated postal-code seed, ~2.7 MB) is tracked with git LFS. If a
fresh checkout shows a ~130-byte file there instead, run:

```sh
git lfs install
git lfs pull
```

Full detail — including why this looks like a corrupt seed rather than a missing download — in
[`docs/runbooks/geodata.md`](./docs/runbooks/geodata.md).

## Docs

- [`docs/design/README.md`](./docs/design/README.md) — status of record: milestones, operating
  rules, the barrel ban, links to per-topic docs (moderation, identity, email, feed, geo, images,
  design system, ops).
- [`docs/platform-differences.md`](./docs/platform-differences.md) — cross-platform traps
  (shadows, keyboard/`position: fixed`), most relevant the day a native target is added.
- [`docs/product-decisions.md`](./docs/product-decisions.md) — the product decisions this
  build rests on, each with what would change the answer. Read before reopening one.
- [`docs/market-research.md`](./docs/market-research.md) — the competitive landscape (free-gifting
  platforms, general marketplaces with a free section, and the "objects with a story" adjacents),
  what is Keepsake's alone, and where it is exposed. Dated; re-check before citing a number.
- [`docs/seeding-and-distribution.md`](./docs/seeding-and-distribution.md) — how to get real
  listings into Houston (named partners, ranked tactics) and which channels can legitimately carry
  them outward (Facebook, Nextdoor, Craigslist, Trash Nothing, feeds). Dated 2026-09-09.
- [`docs/runbooks/`](./docs/runbooks/) — deploy, restore, migrations, admin, incident, geodata,
  the UK block and its re-entry checklist, the issue workflow, the post-deploy production
  verification, and [seeding a demo catalogue](./docs/runbooks/seed-catalogue.md) (what can and
  cannot be filled in without a person solving a Turnstile challenge).

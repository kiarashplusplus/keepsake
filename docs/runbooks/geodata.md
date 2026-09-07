# Runbook: postal-code seed data

Status: current (M1).

Keepsake resolves "postcode + radius" without a geocoding API: `apps/api/seeds/postal_codes.sql`
bundles a `country, code -> place_name, admin1, lat, lng` table straight into D1, built once
from GeoNames and loaded per environment. This is a manual seed, not a migration — it doesn't
run automatically on deploy.

This tool still knows how to build a GB table — deliberately left alone even though `GB` was
removed from `@keepsake/contracts/geo`'s `COUNTRIES` on 2026-09-06 as part of geo-blocking the UK
(see [uk-block.md](uk-block.md)). The seeded GB rows are inert without `"GB"` in `COUNTRIES`; this
tool being untouched is what makes re-adding GB later a small, additive change instead of rebuilding
the seed pipeline from scratch.

## Regenerate

```sh
node tools/geodata/build-postal-seed.mjs
```

This downloads `US.zip`, `CA.zip`, `GB.zip` from `download.geonames.org/export/zip/`, extracts
the tab-separated `<CC>.txt` from each with `unzip -p`, normalizes codes, and writes
`apps/api/seeds/postal_codes.sql` (~46k rows across the three countries, batched as `INSERT OR
REPLACE` statements of ≤500 rows each so D1 doesn't choke on one giant statement). No npm
dependency does this — just the `curl` and `unzip` binaries already on any dev machine or CI
runner.

Useful flags:

| Flag | Effect |
|---|---|
| `--out <file>` | write somewhere other than `apps/api/seeds/postal_codes.sql` |
| `--countries US,CA,GB` | regenerate a subset (e.g. `--countries CA` while iterating on the CA normalization) |
| `--dry-run` | fetch and parse, but only print row counts — nothing is written to disk |

Normalization (per `tools/geodata/build-postal-seed.mjs`):

- **US**: first 5 digits of the ZIP.
- **CA**: first 3 characters of the postal code, uppercased — the FSA (Forward Sortation Area).
  GeoNames' CA export has multiple rows per FSA; the first one wins, since collapsing to FSA
  granularity is already an approximation and the rows for one FSA sit within a few km of
  each other.
- **GB**: the outward code (before the space), uppercased. GeoNames' GB export is already at
  outward-code granularity, so this is mostly case/whitespace normalization.

Regenerating is rare — do it when GeoNames' data changes materially, or the country list grows.
Re-run the whole thing (not just one country) before committing, so the header's row counts and
generation date stay accurate.

## Load into D1

The seed is loaded directly, not through `wrangler d1 migrations apply` — migrations are schema,
this is bulk data, and re-running it is idempotent (`INSERT OR REPLACE`) rather than one-shot.

```sh
# Preview
pnpm --filter @keepsake/api exec wrangler d1 execute keepsake-db --env preview --remote \
  --file apps/api/seeds/postal_codes.sql

# Production
pnpm --filter @keepsake/api exec wrangler d1 execute keepsake-db --env production --remote \
  --file apps/api/seeds/postal_codes.sql
```

Run this once per environment after `0002_geo.sql` (which creates the `postal_codes` table) has
been applied. Sanity-check afterward:

```sh
wrangler d1 execute keepsake-db --env preview --remote --command \
  "SELECT country, code, place_name, admin1 FROM postal_codes WHERE country='US' AND code='02144'"
```
should return `Somerville, MA`.

## Failure mode: the 130-byte "seed"

`apps/api/seeds/*.sql` is tracked with git LFS (see `.gitattributes`). A checkout that hasn't run
`git lfs pull` sees a ~130-byte text file — the LFS pointer (`version
https://git-lfs.github.com/spec/v1 ...`) — where the real ~2.7 MB seed should be. It looks like a
corrupt or truncated seed, not a missing download, and the symptoms are easy to misread:

- `wrangler d1 execute --file` "succeeds" almost instantly and loads nothing (the pointer text
  isn't valid SQL D1 chokes hard on, or it inserts a handful of garbage rows depending on how it
  parses).
- Postcode lookups all 404, and it looks like a backend bug rather than a data problem.

Fix:

```sh
git lfs install
git lfs pull
```

`tools/preflight/preflight.mjs`'s `lfs-pointers` check catches this before it gets that far —
it fails with the same fix command if any `apps/api/seeds/*.sql` still starts with the LFS
pointer header.

## Attribution (About page)

Postal code data from [GeoNames](https://www.geonames.org/), licensed under
[Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/). Required
wherever this data is displayed — the About page must carry this credit; do not ship a build
that bundles GeoNames data without it.

# tools/geodata

`build-postal-seed.mjs` turns GeoNames' postal-code exports into
`apps/api/seeds/postal_codes.sql` — the bundled `country, code -> place, lat, lng` table Keepsake
uses for postcode + radius search (no geocoding API).

```sh
node tools/geodata/build-postal-seed.mjs                       # regenerate all three countries
node tools/geodata/build-postal-seed.mjs --dry-run --countries CA   # just print counts
node tools/geodata/build-postal-seed.mjs --out /tmp/x.sql           # write elsewhere
```

No npm dependency — it shells out to `curl` and `unzip`, both already present on dev machines
and CI runners.

For when/why to regenerate, how to load the result into D1, the LFS-pointer failure mode, and the
CC BY attribution text, see [`docs/runbooks/geodata.md`](../../docs/runbooks/geodata.md).

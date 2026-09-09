# `test/fixtures/public`

The stand-in for `apps/web/dist` that `vitest.config.ts` points the `ASSETS`
binding at — `wrangler.toml`'s real `directory = "../web/dist"` is a build
output this package must not depend on. Each file's own comment says what it
stands in for; `og-default.png` cannot carry one, so it is here.

**`og-default.png`** is a 1×1 PNG in the table's own kraft colour, not a copy
of the real 1200×630 card. It exists because
`src/routes/ogCard.ts`'s `serveDefault` streams `/og-default.png` through this
binding, and nothing asserts its pixels — only that the route answers 200 with
`X-Keepsake-OG-Fallback` rather than failing.

It was added on 2026-09-09 and it is worth knowing why it was not needed
before. Under `not_found_handling = "single-page-application"` the binding
answered the missing `og-default.png` with `index.html` at **200**, so
`serveDefault`'s `if (!asset.ok)` was false and the route streamed the SPA
shell's HTML out under `Content-Type: image/png`. The test passed on the
status and the header while the bytes were wrong, and on a real deploy the
same path would have handed every unfurler the homepage's HTML as a PNG if the
asset ever went missing. `404-page` handling turned that into the honest 404
the fallback was written for, which is what surfaced the gap.

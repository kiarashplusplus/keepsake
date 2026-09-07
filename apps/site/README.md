# The static marketing pages

`public/` holds the pages that are not part of the Expo app: `/about`, `/privacy`, `/terms`,
`site.css`, `og-default.png`, and `consent.js`.

**These are not a separate deployable.** `apps/web/scripts/copy-site.mjs` copies `public/*` into
`apps/web/dist` after `expo export`, and the Worker serves the result through its `[assets]`
binding. The app owns `/`, `/give`, `/item/*` and its own hashed assets; the site owns the paths
above. A collision between the two is a bug and `copy-site.mjs` fails loudly on it.

Two consequences worth knowing before you edit anything here.

**`consent.js` is shared, not duplicated.** It is the single implementation of the consent store,
the banner, and every third-party loader — the same file `apps/web/app/+html.tsx` loads, so one
decision covers these pages and the app. Editing it changes both. The two analytics ids are
substituted at build time from `EXPO_PUBLIC_*`; an unsubstituted `%NAME%` placeholder means "not
configured" and nothing third-party loads.

**Anything third-party you add here needs a CSP entry too.** The policy lives in
`apps/api/src/middleware/securityHeaders.ts` and `apps/web/public/_headers`, and both must agree.
This has already bitten once: the policy shipped without `www.googletagmanager.com` or
`static.cloudflareinsights.com`, so a visitor who *granted* consent had the script refused by the
browser. The tests passed; the browser console was where it showed up.

## These pages are tested

`e2e/consent.spec.ts` and `e2e/a11y.spec.ts` drive these exact pages through the built bundle, so
a change here can break the end-to-end suite even though no TypeScript changed.

CI knows that now, but did not always. `apps/site/**` matched no paths filter, so a pull request
editing `privacy.html` skipped every job and still reported green — GitHub shows a skipped job as
a green check. The `site` filter in `.github/workflows/ci.yml` fixes that, and
`tools/ci/assert-coverage.mjs` asserts it stays fixed rather than trusting it.

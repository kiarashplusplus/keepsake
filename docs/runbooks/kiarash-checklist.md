# What's blocked on Kiarash

Everything here is now done except one Turnstile hostname (#73). Kept as the record of what was
set up and how it was verified. The production cutover (section 6 below) is **done** as of
2026-09-07: `keepsake.ing` is live, serving the real app, with `PRODUCTION_LIVE` set.

Account: **Leapkg@gmail.com's Account**, id `dc6a87ed4a4269ed74c8f508b275b703`
Zone: **keepsake.ing**, id `dcc1fb09eeeba27a343fc1d98aff9094`
Preview Worker: **keepsake-preview** → <https://keepsake-preview.leapkg.workers.dev>
Production Worker: **keepsake-production** → <https://keepsake.ing> (custom domain attached)

Paste anything you get back (site keys, tokens) into chat and I'll wire it up and verify.

---

## 1. ~~Email Service — onboard `keepsake.ing`~~ ✅ DONE 2026-09-06

Enabled, DNS configured, sending from `hello@keepsake.ing`, quota 1000/day. First real
delivery confirmed in `email_events` (`provider=cf, ok=1`).

## 2. ~~Turnstile~~ ✅ DONE 2026-09-06

Widget `Keepsake` (managed), hostnames `keepsake.ing` and `preview.keepsake.ing`, sitekey
`0x4AAAAAAEqUUMHIymlBJ3pb`. Secret set on the preview Worker; site key set as an environment
variable for both tiers. Verified on preview: a request with no token and a request with a
bogus token are both refused with `turnstile_failed`, while the feed, item pages and health
stay open. Playwright is unaffected — it runs with no secret, which soft-passes by design.

## 3. ~~DNS — `preview.keepsake.ing`~~ ✅ DONE 2026-09-06

Attached to the `keepsake-preview` Worker via the API (the `cf` token has DNS Write and
Workers Routes Write). `SITE_URL` now points at it, so share links, Open Graph tags and the
sitemap all use the real domain. Verified: `/health` 200, `/`, `/about`, `/give/`, `/mine/` all
200, item unfurl shows `https://preview.keepsake.ing/...`.

## 4. ~~GitHub Environments~~ ✅ DONE 2026-09-06

- Minted `keepsake-ci-deploy`, scoped to Workers Scripts / KV / R2 / D1 write plus Account
  Settings read on this account, and Workers Routes write on the zone. Verified it *cannot*
  write DNS or mint further tokens. Your broad `cf` token stays on your machine.
- `preview` and `production` environments created, each with `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID`; site URL and env variables set per tier; the production site key is
  in place.
- `DEPLOY_ENABLED=true`.
- **Production is manual only.** GitHub's required-reviewers gate is a paid feature on private
  repos, so instead of letting a merge to main ship the public site, `deploy.yml` now takes
  production only from a `workflow_dispatch` run (Actions tab → Deploy → choose `production`).
  Preview deploys itself on every PR and every push to main.

## 5. Turnstile hostname for per-PR previews — one click, only when #73's CI work starts

The `keepsake-pr-preview` Cloudflare token is done and verified (see
`docs/runbooks/deploy.md#the-per-pr-preview-token-73`): it can create and delete the Worker, D1
database, R2 bucket and KV namespace each PR preview needs, it is stored as the preview
environment secret `CLOUDFLARE_PR_PREVIEW_TOKEN`, and it deliberately cannot mint tokens or touch
DNS. The one thing no token here can do is Turnstile.

Dashboard → Turnstile → widget **Keepsake** → add the hostname **`leapkg.workers.dev`**. Turnstile
hostnames cover their subdomains, so that one entry covers every future `keepsake-pr-<n>` Worker;
wildcards are rejected, and the free tier allows 10 hostnames per widget, so adding one per PR is
not an option. Know what you're accepting: `leapkg.workers.dev` is shared across every Worker on
this account, so any of them could use the Keepsake site key. Declining is also a real answer — PR
previews would then run with Turnstile unenforced, which is fine for reading and useless for
verifying a write path.

Nothing is waiting on this until the per-PR deploy job in #73 is actually built.

## 6. ~~Production cutover~~ ✅ DONE 2026-09-07

`keepsake-production` migrated and seeded, secrets set, deployed, `keepsake.ing` attached as its
custom domain and confirmed serving the real app in a browser. Repository variable
`PRODUCTION_LIVE = true` is set, so the production half of the every-15-minutes `/health` check in
`.github/workflows/uptime.yml` is now active.

Still to do, now that the domain is live:
1. Post the first real keepsake from your phone and watch it through moderation.
2. Confirm `robots.txt` differs between the two hosts: `curl https://keepsake.ing/robots.txt`
   must show `Allow: /` and a `Sitemap:` line, and `curl https://preview.keepsake.ing/robots.txt`
   must show `Disallow: /` with `https://preview.keepsake.ing/sitemap.xml` returning 404. Preview
   was fully indexable until 2026-09-06 (launch audit finding 2); this is the one-command check
   that it still is not.

---

## Guardrails already in place (so you do not have to worry about this)

`sendMail` refuses to send anywhere that would bounce, because Cloudflare scores the domain on
bounce rate (safe under 2%, at risk at 5%) and this repo carries 80 `@example.com` fixtures:

| Environment | `EMAIL_MODE` | Effect |
|---|---|---|
| local + Playwright e2e | `off` | Nothing is ever sent. CI cannot mail anyone. |
| preview | `allowlist` | Only `EMAIL_ALLOWLIST` addresses (currently just Kiarash). |
| production | `live` | Real users. |

Reserved domains (`example.com/net/org`, `.test`, `.invalid`, `.localhost`, `.local`) are refused
in **every** environment, production included — they are reserved by standard precisely so they
can never accept mail. The guard fails closed if `EMAIL_MODE` is unset, blocked attempts are still
written to `email_events` so nothing disappears silently, and a config test reads `wrangler.toml`
and fails the build if the test-only bypass ever appears there.

Verified live on preview 2026-09-06: `nobody@example.com` → `blocked_reserved_domain`,
`stranger@gmail.com` → `blocked_not_allowlisted`, `kiarasha@alum.mit.edu` → sent.

## What is *not* blocked on you

Already working on preview and verified against the live stack: give flow with real Workers AI
moderation, feed with search and postcode-radius, item pages with link previews, requests,
choosing a recipient, the admin queue, bans, and the nightly cleanup. The one thing I cannot
prove without step 1 is that an email actually arrives.

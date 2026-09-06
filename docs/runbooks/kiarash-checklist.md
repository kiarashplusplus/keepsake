# What's blocked on Kiarash

Five things need a human with dashboard access. Everything else in M0–M4 is built, tested and
running on preview. Do them in this order — each one unblocks the next round of verification.

Account: **Leapkg@gmail.com's Account**, id `dc6a87ed4a4269ed74c8f508b275b703`
Zone: **keepsake.ing**, id `dcc1fb09eeeba27a343fc1d98aff9094`
Preview Worker: **keepsake-preview** → <https://keepsake-preview.leapkg.workers.dev>
Production Worker (not deployed yet): **keepsake-production**

Paste anything you get back (site keys, tokens) into chat and I'll wire it up and verify.

---

## 1. ~~Email Service — onboard `keepsake.ing`~~ ✅ DONE 2026-09-06

Enabled, DNS configured, sending from `hello@keepsake.ing`, quota 1000/day. First real
delivery confirmed in `email_events` (`provider=cf, ok=1`).

## 2. Turnstile — widget created, one hostname missing

The widget exists (`Keepsake`, managed, sitekey `0x4AAAAAAEqUUMHIymlBJ3pb`) but its hostname
list is only `keepsake.ing`. Turnstile refuses to render on a host that is not listed, so
enabling it on preview right now would break every write there.

**The one thing left:** Turnstile → the `Keepsake` widget → add `preview.keepsake.ing` to
Hostnames. Then tell me and I will set `TURNSTILE_SECRET` on the preview Worker, add the site
key to the preview build, and verify that a request with no token is refused.

The `cf` token cannot do this: its permissions are Workers Routes Write, DNS Write, API Tokens
Write, Workers Scripts/KV/R2/Pages/AI Write and Account Settings Read — no Turnstile scope, so
both create and update return `10000 Authentication error`.

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

## 5. Production cutover — only when you're ready to be public

**Do not do this until 1–4 are done and you've used preview yourself.** Nothing is on
`keepsake.ing` today.

When you say go, I will:
1. Apply the migrations and load the postal-code table into the production database.
2. Set the production secrets (`TURNSTILE_SECRET`, `ADMIN_TOKEN`, optional `SENTRY_DSN`).
3. Deploy `keepsake-production` and check `/health` reports the exact commit.
4. Ask you to add the custom domain `keepsake.ing` (same clicks as step 3) — I can't create it.
5. Post the first real keepsake from your phone and watch it through moderation.

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

# What's blocked on Kiarash

**Everything on this page is done except §7.** The production cutover (§6) happened on
2026-09-07 — `keepsake.ing` is live (#46) — and §5 turned out not to be needed at all (#73 was
reversed the same day it was decided). What is left is the two paper errands in §7, off this
computer entirely, tracked as **#142**.

The rest is kept as the record of what was set up and how it was verified, not as a to-do list.
Two things a human still owes that are *not* on this page, because they are verification rather
than setup: walking the app on a phone (**#42**) and running
[verify-production.md](verify-production.md) against the live apex (**#47**).

Account: **Leapkg@gmail.com's Account**, id `dc6a87ed4a4269ed74c8f508b275b703`
Zone: **keepsake.ing**, id `dcc1fb09eeeba27a343fc1d98aff9094`
Preview Worker: **keepsake-preview** → <https://keepsake-preview.leapkg.workers.dev>
Production Worker: **keepsake-production** → <https://keepsake.ing> (live since 2026-09-07; both
of its `workers.dev` hostnames are disabled, so the apex is the only way in)

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
  Preview deploys itself on **every push to `main`, and nothing else** — the "and every PR" half
  of this line was true when it was written and was removed by #73 later the same day.

## 5. ~~Turnstile hostname for per-PR previews~~ — NOT NEEDED, #73 reversed 2026-09-07

**Do not do this.** #73 was decided for per-PR previews in the morning and reversed the same day:
preview deploys from `main` only, per-PR Workers declined (shipped in #107). There is no
`keepsake-pr-<n>.leapkg.workers.dev` origin to allow, so adding `leapkg.workers.dev` to the widget
would buy nothing and would hand the Keepsake site key to every other Worker on the account for no
return. Kept as the record of what the errand was, and what it would cost, if per-PR previews are
ever reconsidered.

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

## 6. ~~Production cutover~~ ✅ DONE 2026-09-07 (#46)

`keepsake.ing` serves `keepsake-production`, both of that Worker's `workers.dev` hostnames are
disabled, `PRODUCTION_LIVE = true` is set so `uptime.yml` genuinely probes the apex every 15
minutes, and production deploys stay manual (`workflow_dispatch`). Steps 1–5 and 7 below all
happened; the "Nothing is on `keepsake.ing` today" line this section opened with is the single
most out-of-date sentence this file has carried.

**Step 6 is the one that did not.** Nobody has posted a real keepsake from a phone and watched it
through moderation on the live apex — that is #47 (with #42 for the phone walkthrough), and
[verify-production.md](verify-production.md) is the copy-pasteable version of the rest. An agent
container cannot do either: egress answers `403` to `CONNECT keepsake.ing:443`.

The original plan, kept because it is the record of what was actually done:
1. Apply the migrations and load the postal-code table into the production database.
2. Set the production secrets (`TURNSTILE_SECRET`, `ADMIN_TOKEN`). Observability no longer needs
   one: issue #14 replaced `@sentry/cloudflare` (blocked on a Sentry account only you could create)
   with Workers Logs, which is a `wrangler.toml` config flag, not a secret — the auto-hide alert,
   the cron-failure alert and every unhandled route error are captured as soon as the Worker
   deploys, no setup step here required.
3. Deploy `keepsake-production` and check `/health` reports the exact commit.
4. Ask you to add the custom domain `keepsake.ing` (same clicks as step 3) — I can't create it.
5. Set the repository variable **`PRODUCTION_LIVE = true`** (Settings → Secrets and variables →
   Actions → Variables). That is what turns on the production half of the every-15-minutes
   `/health` check in `.github/workflows/uptime.yml`. If it is forgotten, the workflow notices —
   it fails with "production is live but unmonitored" as soon as `keepsake.ing/health` answers
   while the variable is unset — but setting it here saves the false alarm.
6. Post the first real keepsake from your phone and watch it through moderation.
7. Confirm `robots.txt` differs between the two hosts: `curl https://keepsake.ing/robots.txt`
   must show `Allow: /` and a `Sitemap:` line, and `curl https://preview.keepsake.ing/robots.txt`
   must show `Disallow: /` with `https://preview.keepsake.ing/sitemap.xml` returning 404. Preview
   was fully indexable until 2026-09-06 (launch audit finding 2); this is the one-command check
   that it still is not.

## 7. ~~Cache-purge token for global photo purge (#94)~~ ✅ DONE 2026-09-07

Nothing for you here — recorded because #94 was `blocked-on-kiarash` on exactly this. Minted
**`keepsake-cache-purge`** (id `1dc0212c…`), one permission — `Zone → Cache Purge` — on the
`keepsake.ing` zone and nothing else, and stored it as the Worker secret `CF_CACHE_PURGE_TOKEN` on
both `keepsake-preview` and `keepsake-production`. `CF_ZONE_ID` was already in `wrangler.toml` for
both tiers, so #117's purge code went from an inert no-op to live the moment the secret landed.

Proven live rather than assumed: it purges `keepsake.ing`, it is refused against another zone on
this account and against a DNS read of its own zone, and one purge call cleared a photo cached at
two different colos at once. Full measurements — including the two ways this is easy to false-pass
and the one link still unverified — in `docs/runbooks/deploy.md#the-cache-purge-token-94`.


## 8. Cloudflare Web Analytics — mostly done, one optional token (#228, #231, #233)

Nothing blocking. Recorded because three of these needed you and the fourth still might.

Done on 2026-09-07: `EXPO_PUBLIC_CF_WEB_ANALYTICS_TOKEN` set as a **variable** (not a secret — it
ships in the HTML) on both GitHub Environments, and the site switched from automatic injection to
**"Enable with JS Snippet installation"** so `consent.js` stays the only thing that loads the
beacon. Before that switch, Cloudflare was injecting it at the edge and the banner's "Reject all"
did nothing (#231).

**Optional, when it next annoys someone.** No Cloudflare token in `~/Documents/.env` can *write*
Web Analytics config — creating a site or changing the installation mode both return `403`, so
they are dashboard actions. A token with **Account → Web Analytics → Edit** would close that, and
would let a separate analytics site be created for `preview.keepsake.ing` so staging traffic stops
sharing production's. Neither is urgent: the hostname is recorded on every event, so the two are
already separable in the dashboard.

**Still outstanding, and it is a deploy rather than a click (#232).** Production serves no beacon
token at all, because an `EXPO_PUBLIC_*` value is inlined at build time and only reaches a tier
deployed *after* it was set. Production analytics stays dark until `deploy.yml` is dispatched with
`environment: production` — which ships whatever backlog `main` has accumulated and applies D1
migrations, so it is a release decision, not a config one.

## 9. Two paper things, off this computer entirely (#108, tracked as #142)

Neither is a Cloudflare click and neither blocks a deploy. Both fall out of the 2026-09-07 decision
to keep Keepsake a sole proprietorship rather than form an LLC — the reasoning, the numbers and the
triggers that would reverse it are in
[`docs/legal-entity-and-insurance.md`](../legal-entity-and-insurance.md). The short version is that
the decision is only conservative if these two actually happen; without them it is just "no entity."

**a. General-liability cover.** This is the protection the LLC would not have given you anyway — an
LLC does not shield you from a claim that *you* screened a listing negligently, and you are the only
person who screens anything. What a policy buys that no clause on `terms.html` can is a **duty to
defend**: the insurer pays for the lawyer even on a suit it thinks is groundless, which is the
realistic bad day here. Right now there is **no cover at all** — your renter's policy excludes
"business pursuits," so it would not answer a Keepsake claim.

Use a broker, not a quote form, and ask in this order: (1) will anyone write a one-person,
zero-revenue marketplace whose product is arranging in-person meetings between strangers? (2) which
policy answers "a user was hurt meeting another user we introduced" — the CGL, or tech E&O /
media liability, since a claim that the *screening* was inadequate can land in the CGL's
professional-services exclusion? (3) read three exclusions before looking at price: professional
services, assault and battery, and anything excluding claims arising out of meetings arranged
between users — that last one would exclude the whole product. Then price: **$300–$800/year** is the
band a quote for this shape should be sanity-checked against.

**b. The assumed-name certificate (DBA).** "Keepsake" is not your surname, so Business & Commerce
Code ch. 71 wants a certificate filed with the **Harris County Clerk** — form 02-07 (1–3 owners),
signed before a notary or a deputy clerk, good for ten years, tens of dollars. The reason to bother
is §71.201: without it you can still *defend* a suit and your contracts stay valid, but you **may
not maintain** an action in a Texas court arising out of a contract made in the assumed name — and
`terms.html` is exactly such a contract. Know before you file that the certificate is a public
county record carrying an address; ask the clerk whether a mailing address other than the residence
is acceptable rather than assuming either way.

The address of record for both, and for anything else that asks: **Kiarash Adl, 2004 San Sebastian
Ct, Apt 2318, Houston, Texas 77058.** It stays off the website on purpose — see that document's
"Where the address goes" section for why.

---

## Guardrails already in place (so you do not have to worry about this)

`sendMail` refuses to send anywhere that would bounce, because Cloudflare scores the domain on
bounce rate (safe under 2%, at risk at 5%) and this repo carries 80 `@example.com` fixtures:

| Environment | `EMAIL_MODE` | Effect |
|---|---|---|
| local + Playwright e2e | `off` | Nothing is ever sent. CI cannot mail anyone. |
| preview | `allowlist` | Only `EMAIL_ALLOWLIST` addresses (currently just Kiarash). |
| production | `live` | Real users. |

### Day-one posture: **live immediately** (decided 2026-09-07, issue #43)

The choice was between opening production email to everyone on day one and running an allowlist
for the first real post before opening up. **Decision: live immediately.** No config change was
needed — `apps/api/wrangler.toml`'s `[env.production.vars]` block already carries
`EMAIL_MODE = "live"` with an empty `EMAIL_ALLOWLIST`, which is exactly this posture.

What that accepts, stated plainly so nobody has to reconstruct it later: **delivery to a real
address that is not Kiarash's has still never been observed** (#6, part 1 — the one test that has
never been run). The worst case #6 describes is that the Cloudflare binding refuses non-verified
destinations outright, in which case no giver hears that someone asked for their keepsake and no
chosen requester hears they were chosen. Going live on day one means the first person to meet that
failure, if it exists, is a real stranger rather than an allowlisted test address.

Two things make that a smaller bet than it was when #43 was filed, and neither of them is a
substitute for running the test:

- A failed send is no longer silent. `f44052a` records it on `requests.notify_failed_reason` and
  renders it on the giver's own dashboard at `/mine/:id`, so a giver sees "we couldn't reach your
  email address" instead of nothing.
- `GET /api/admin/stats` returns a 7-day `email_events` breakdown by `ok`/`error`, so a systematic
  refusal reads as a spike on the admin stats strip within minutes rather than accumulating
  invisibly.

**Still worth doing first, and it costs one message:** send a request and a choose to
`leapkg@gmail.com` on preview (allowlisted there for exactly this) and confirm the mail physically
arrives. That closes #6 and turns this decision from a bet into a checked fact. It is not a
blocker on the decision itself — it is the evidence the decision is currently missing.

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
choosing a recipient, the admin queue, bans, the nightly cleanup, and (since #150) the Observatory
and the daily digest. Step 1 landed long ago, so the sentence that used to close this file — "the
one thing I cannot prove without step 1 is that an email actually arrives" — no longer names a
blocker. What is still true is narrower and does not depend on you unblocking anything: `ok = 1`
in `email_events` records that the provider *accepted* a message, and there is no bounce webhook
or complaint feedback loop behind it, so nothing in this system can tell acceptance from
delivery.

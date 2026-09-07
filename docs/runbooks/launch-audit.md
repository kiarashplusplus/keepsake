# Launch audit — go/no-go for `keepsake.ing`

Audited 2026-09-06 against the live preview deployment (`https://preview.keepsake.ing`, commit
`561994d3`), the repo at local HEAD `6bbbc41`, `apps/api/wrangler.toml`, and the published
`privacy.html` / `terms.html`. Read-only: no code changed, nothing deployed, no Cloudflare or
GitHub state touched. Findings marked **[observed]** were reproduced against the running stack;
findings marked **[code]** were read but not executed.

---

## Status as of 2026-09-07 — read this before the findings below

**`keepsake.ing` is live** (#46, closed): the apex is attached to `keepsake-production` and both of
that Worker's `workers.dev` hostnames are disabled. The audit's own verdict — "go with conditions,
do not attach the apex domain yet" — is therefore **superseded**, and every "must fix before the
domain is attached" item below has been resolved except finding 3.

Nothing in this document has been deleted or rewritten. The findings are the record of what was
true on 2026-09-06, including the sentences that are no longer true; this header is the map from
each of them to what closed it. Where a finding already carries its own inline **Superseded** note,
that note came first and this table agrees with it.

> **Re-checked against GitHub on 2026-09-07, later the same day.** Everything below that said
> "fix merged, issue open" is now **closed**: #86, #87, #88, #89, #90, #91, #92 and #106 all
> closed, as did **#6** (finding 3 — see the caveat in
> [`docs/design/README.md`](../design/README.md#where-this-stands--2026-09-07): the close carries
> no comment, and nothing in the repo records the inbox being read), **#94** (the zone cache-purge
> token) and **#103**. The tables below are left as they were written, per rule 7; read this
> paragraph as the overlay. **All 18 findings and every remainder are now closed as issues.** What
> is still owed is verification, not code: **#47** (the live re-measurement of finding 1, plus the
> first real listing on the apex) and **#42**.
>
> One dangling reference: finding 2's superseded note points at **issue #85** ("whether anything
> indexed during the window before this landed needs a Search Console removal"). #85 has been
> **deleted** from GitHub (`410 This issue was deleted`). Refiled as **#158** — read that, not #85.
> It is small and probably moot (preview was indexable for at most a day) but it was never
> checked.

**Source, and what "closed" means here.** The mapping is taken from
[#49's full reconciliation comment of 2026-09-07](https://github.com/kiarashplusplus/keepsake/issues/49#issuecomment-5565544019),
which re-checked all 18 findings by reading the cited files on `main` rather than trusting closing
comments — and found three closed issues (#7, #20, #28) each hiding an unfinished half, which is
why several rows below say "fixed, with a remainder". Issue states in the last column were
re-checked against GitHub on 2026-09-07. Note that #107's squash commit (`6412c7f`) says
`Closes #86, #87, #88, #89, #90, #91, #92, #99, #106`, but those issues were **still open** when
this header was written; their fixes are on `main` either way, so they are listed as "fix merged,
issue open".

### Must fix before the domain is attached

| # | Finding | Status | Closed by |
|---|---|---|---|
| 1 | No page scrolls | **Fixed** | `apps/web/src/ui/Page.tsx`, commit `e5f96f7` ("Every page scrolls"). No issue number — it was fixed before #49 was filed. **Still owed:** the audit's own re-check (a real wheel event against the deployed build, `/privacy` as the control) has never been re-run; see [verify-production.md](verify-production.md). |
| 2 | Preview fully indexable, publishes its own sitemap | **Fixed** | First pass `af6f0c6`, completed by **#84** (closed) — `run_worker_first = true` so `/` itself reaches the Worker. |
| 3 | `EMAIL_MODE=live` never exercised, failures silent | **OPEN** | **#6** — open, and the only issue still carrying `launch-blocker`. Delivery to any address other than Kiarash's has still never been observed arriving. |
| 4 | Nothing tells anyone the Worker is broken | **Fixed** | **#14** (Sentry → Workers Logs) and **#15** (`/health` does real D1/R2/KV reads), both closed; `.github/workflows/uptime.yml` polls both tiers. **Remainder:** the alerting step had never once delivered — **#106**, fix merged in `6412c7f`, issue open. |
| 5 | No restore path for the production database | **Fixed** | **#17** (closed) — `docs/runbooks/restore.md` (D1 Time Travel + `d1 export`), `tools/backup-photos.mjs` + `backup-photos.yml`. |
| 6 | Admin token brute-forceable | **Fixed** | `af6f0c6` — `burst("RL_ADMIN")` now runs before `adminAuth()`, both 401 bodies identical. Flaky guard for it fixed under **#65** (closed). |
| 7 | Privacy policy: two false statements, no age, no controller | **Fixed, two remainders** | **#7**, **#25**, **#26**, **#27**, **#28**, **#60**, **#62** — all closed. **Remainders:** **#87** (the rate-limit IP hash still never day-salted) and **#88** (AI title/category generation undisclosed) — both fixes merged in `6412c7f`, both issues open. |

### Fix in the first week

| # | Finding | Status | Closed by |
|---|---|---|---|
| 8 | Global moderation budgets exhaustible by ~50 addresses | **Fixed** | **#18** (closed) — reserved floor in `pipeline.ts`, `alertBudgetExhaustedOnce` to Workers Logs. |
| 9 | `RL_READ` declared everywhere, called from nowhere | **Fixed** | `af6f0c6` — `burst("RL_READ")` wired onto `item`, `feed`, `geo`, `images` and listing GETs. |
| 10 | Burst limiter far leakier than its configured number | **Superseded** | **#8** (closed) — `burst()` is now documented as best-effort and `dailyBudget()` as the hard cap. **Remainder:** two routes had no hard cap at all — **#92**, fix merged in `6412c7f`, issue open. |
| 11 | `owners` rows minted before any limiter, never swept | **Fixed** | Fixed before #49 was filed — `burst()` ahead of `ownerAuth({createIfMissing:true})`, and `orphanSweep` sweeps empty `owners` rows after 30 days. |
| 12 | Cron failures invisible, including to Sentry | **Fixed** | **#16** (closed) — `scheduled()` genuinely awaits each job and rethrows, `moderationRetry` wraps each item, the heartbeat renders on the admin page with a stale-red badge. |
| 13 | Admin queue at 200 items is a lost evening | **Fixed** | **#11** (closed) — keyboard nav, bulk actions, debounced stats. **Remainder:** the N+1 the audit said "can wait" is now tracked as **#91**, fix merged in `6412c7f`, issue open. |
| 14 | Turnstile dead-ends when the widget fails | **Fixed** | **#3** (closed) — the error callback no longer enables submit with an empty token. |
| 15 | Photos of rejected/withdrawn/hidden listings kept forever | **Fixed** | Fixed before #49 was filed — `orphanSweep`'s `TERMINAL_STATUSES` sweep after a 30-day grace period. |
| 16 | A requester has no way to remove their data | **Fixed** | **#9** (closed) — `requestWithdraw.ts`, a real signed-token self-service path. **Remainder:** the `ON DELETE CASCADE` positive control the audit explicitly asked for — **#90**, fix merged in `6412c7f`, issue open. |
| 17 | No security headers at all | **Fixed** | **#10** (closed) — `apps/web/public/_headers` plus `middleware/securityHeaders.ts` for every Worker response. |
| 18 | Migrations apply before the Worker deploys; docs wrong | **Fixed (docs)** | **#13** and **#24**, both closed. The ordering itself is unchanged and deliberate — `deploy.md` now explains why, and documents `wrangler rollback`. |

### Worth knowing

| Item | Status | Closed by |
|---|---|---|
| Version-skew guard doesn't exist on the client | **Fixed** | **#23** (closed) — `useVersionSkewGuard.ts` polls `/version.json`; prefix compare, not `===`. |
| `MAX_PHOTOS` / `IMAGE_TRANSFORMS_ENABLED` read by nothing | **Fixed** | Removed from `wrangler.toml` outright, with the reasoning left in place as a comment. |
| `COMMIT_SHA = "dev"` in the production var block | **Fixed** | **#24** (closed) — the Worker now refuses *every* production request in that state, and `uptime.yml` treats it as its own failure. |
| The takedown path at 3am is nobody | **Remainder open** | **#89** — auto-hide reaches a log line, but nothing pages anyone; fix merged in `6412c7f`, issue open. |
| Request note not moderated | **Fixed** | **#19** (closed). |
| Email subject interpolates the title unescaped | **Fixed** | **#20** (closed). **Remainder:** one missed call site — **#86**, fix merged in `6412c7f`, issue open. |
| Requesting a just-given keepsake says "not found" | **Fixed** | **#21** (closed) — now `410`. |
| Edge cache may outlive deletion | **Fixed** | **#22** (closed) — `purgePhotoCache()` on both the owner-delete and cron-sweep paths. Its one real limit (a purge reaches only the requesting colo) is **#94**, open, `blocked-on-kiarash`. |
| `Disallow: /admin` advertises the admin path | **Fixed** | **#84** (closed) — line removed; `/admin` kept out of search by an unconditional `X-Robots-Tag: noindex`. |
| Llama Guard lenient on text about objects | **Accepted** | Documented risk in `docs/design/moderation.md`; no issue filed, mitigated by the vision pass and the report button. |

### What is still owed

*As written 2026-09-07 morning, then corrected the same evening — the corrections are the point:*

- ~~**#6** — the one real launch blocker: production email proven to reach a stranger.~~ **Closed
  08:54 UTC**, with no closing comment and no recorded result for the inbox check its own last
  comment demanded. Not reopened here; flagged in `docs/design/README.md` so nobody re-derives
  either the old claim or a proof that was never written down.
- Finding 1's live re-measurement, and the rest of the post-cutover checks that need a real
  network: [verify-production.md](verify-production.md), tracked by **#47**. **Still owed** — this
  is the one line in this section that has not changed.
- ~~The open remainders above (#86-#92, #106) whose fixes are merged but whose issues have not been
  closed out.~~ All closed.
- **New, and not from this audit**: #116 (the `adminAuth` flake is back on unmodified `main`, so
  #65's fix did not hold), #145 (DNSSEC off on the zone), #147 (an api-only pull request never runs
  `e2e`), and, filed 2026-09-07 out of the docs sweep: #155 (no human can correct a listing's
  category), #156 (the stranded per-PR preview token), #157 (production photos have never been
  backed up), #158 (above), #159 (decide whether push alerting is worth it).

---

## Verdict: **go with conditions** — do not attach the apex domain yet

> **Superseded 2026-09-07** — the domain is attached (#46) and every condition below except
> finding 3 (#6) is met. See "Status as of 2026-09-07" above. The verdict is kept verbatim as the
> record of the call made on 2026-09-06.

The product is real and the engineering underneath it is better than most things at this stage:
the moderation pipeline fails closed, the contact-reveal masking is correct, the admin compare is
genuinely constant-time, photo deletion really does remove the R2 bytes, the OG injection escapes
its inputs and leaks nothing the page doesn't already show, and production deploys are manual by
design. But three things would each, on their own, embarrass the founder on day one, and all three
are cheap to fix. **The app does not scroll on a phone** — I measured it: a wheel gesture on the
live feed moves the page 0 px while 745 px of content sits below the fold. **The preview twin is
publicly indexable** and advertises its own sitemap, so Google can list a second Keepsake whose
notification emails are silently dropped. And **production email has never delivered to an address
that is not Kiarash's** — `EMAIL_MODE=live` will be exercised for the first time by a real
stranger, on a code path that swallows every failure. Behind those sit two systemic gaps: nothing
anywhere tells a human that the Worker is broken, and there is no documented restore path for the
production database. Fix the seven items in "must fix" — realistically half a day, most of them
one-liners — and this is a defensible launch. Ship it as it stands today and the first phone that
opens it cannot use it.

---

## Must fix before the domain is attached

### 1. No page in the app scrolls. The app is unusable on a phone. [observed]

This is the top of the known-unfixed list and it is not a polish item — it is the whole product
being unreachable below 844 px.

Measured on preview at a 390×844 viewport, dispatching a real wheel event:

| Page | content height | viewport | after wheel |
|---|---|---|---|
| `/` (feed) | 1589 px | 844 px | **scrollY 0** |
| `/item/01M1TEVSEDJDEVN5Q1D9BBW4ZR` | 977 px | 844 px | **scrollY 0** |
| `/privacy` (the static marketing page) | 2782 px | 844 px | scrollY 900 ✅ |

The `/privacy` row is the positive control: the same test, the same browser, a page that does
scroll. So the test can fail, and the app pages fail it. `document.body` computes to
`overflow: hidden` with `html { height: 100% }` (`apps/web/app/+html.tsx:32`), no route mounts a
scroll container (`internalScrollers: 0` on every app route I measured), and a programmatic
`window.scrollTo` still moves the viewport — which is exactly why the screenshot tooling never
caught this: `captureBeyondViewport: true` in `apps/web/scripts/screenshots-v4.mjs` renders as if
scrolled.

On the feed, everything after the first listing is unreachable. On an item page, 133 px is cut —
which includes part of the "I'd love this / Share / Report" row, the only three actions a visitor
has.

**Worst case:** the founder shares the link, the first ten people open it on a phone, see one
keepsake and no way to act on it, and leave. There is no error to report and nothing in the logs.

**Fix:** the `Page` component (Part 0 of the in-flight plan) is written but untracked
(`apps/web/src/ui/Page.tsx` is `??` in `git status`) and is not on preview. Land it, then re-run
the exact measurement above against the deployed build — content height, viewport, and scrollY
after a wheel, with `/privacy` alongside as the control. A Playwright assertion that
`scrollHeight > innerHeight` is not sufficient on its own: it is already true today, on the broken
build.

### 2. `preview.keepsake.ing` is fully indexable and publishes its own sitemap. [observed]

```
$ curl -s https://preview.keepsake.ing/robots.txt
User-agent: *
Allow: /
Disallow: /admin

$ curl -s https://preview.keepsake.ing/sitemap.xml
  <url><loc>https://preview.keepsake.ing/</loc>…
  <url><loc>https://preview.keepsake.ing/about</loc>…
  <url><loc>https://preview.keepsake.ing/item/01M1TEVSEDJDEVN5Q1D9BBW4ZR</loc>…
```

`apps/web/public/robots.txt` is a single static asset shared by both deploys, and
`apps/api/src/routes/sitemap.ts:31` builds every URL from `SITE_URL`, which on preview is the
preview host. So preview is a fully functional, crawlable, brand-named clone of the product.

**Worst case:** someone searching "keepsake.ing" lands on preview, posts a real keepsake with a
real photo and a real story, and gets nothing — because preview's `EMAIL_MODE=allowlist`
(`wrangler.toml`, `[env.preview.vars]`) silently drops every address that is not
`kiarasha@alum.mit.edu`. Their listing sits in a database the founder isn't watching, requests
arrive that nobody is emailed about, and the founder is meanwhile competing with himself in search
results.

**Fix:** serve `User-agent: *\nDisallow: /` and an `X-Robots-Tag: noindex` header whenever
`ENVIRONMENT !== "production"`, and short-circuit `/sitemap.xml` to empty off production. Both are
a few lines in the Worker, which already has `ENVIRONMENT` in hand. Consider Cloudflare Access in
front of the preview host as well; there is no reason it should be open to the internet.

**Superseded 2026-09-07 (issue #84, following an initial pass in commit `af6f0c6`):** fixed, in two
rounds. The first pass added exactly the `robots.ts`/`sitemap.ts` handlers this section describes,
gated on `ENVIRONMENT`, reached via `run_worker_first` for `/robots.txt` and `/sitemap.xml`. Curling
the real host after that pass confirmed both were fixed — but also turned up a gap the first pass
didn't cover: `run_worker_first` was a literal-path list, and `/` (the feed root — the one page a
searcher would actually land on) matched a real static asset and so was answered by Cloudflare's
assets system *without ever invoking the Worker*, meaning the `X-Robots-Tag: noindex` middleware
never ran for it, or for `/about`, `/give`, `/mine`, or any other pre-rendered page. `/item/:id` was
fine (explicitly listed), which is exactly why the gap was easy to miss from the code alone.
`run_worker_first` is now `true` (every request) on dev and preview, so a future page can't silently
land in the same hole a list requires remembering to update. Verified against real `wrangler dev`
(the local test suite can't see this class of bug — miniflare doesn't reproduce the asset-precedence
rule; see `apps/api/test/robotsConfig.test.ts`) for both `--env preview` (header present on `/`) and
`--env production` (absent, no regression). Also closed the adjacent "worth knowing" item below:
`Disallow: /admin` is gone from the public `robots.txt`, replaced by an unconditional
`X-Robots-Tag: noindex` on that one path in every environment. Issue #85 (blocked on Kiarash) covers
whether anything indexed during the window before this landed needs a Search Console removal.
**[#85 has since been deleted from GitHub; that question is #158 now.](https://github.com/kiarashplusplus/keepsake/issues/158)**

### 3. `EMAIL_MODE=live` has never been exercised against a real stranger, and every failure is silent. [code]

`docs/runbooks/kiarash-checklist.md` records the only proven delivery as one to
`kiarasha@alum.mit.edu` — almost certainly a verified destination address on the Cloudflare
account. That is the one address for which the `[[send_email]]` binding is guaranteed to work.
The binding is declared bare (`[[send_email]] name = "EMAIL"`, no destination restrictions), and
whether Email Service will accept an arbitrary recipient from `hello@keepsake.ing` is an assertion
in `docs/design/email.md`, not an observation.

The reserved-domain guard is *not* the only thing between us and a bounce problem, but it is the
only *recipient* filter once `EMAIL_MODE=live` (`sendMail.ts:90` — `if (mode === "live") return
{ allowed: true }`). The other layer is `MailableEmailSchema` at the form
(`packages/contracts/src/common.ts:109`), which is the same reserved-domain list. Neither catches
a typo'd real domain, a dead mailbox, or a spam trap. And there is no third layer:

- Every send site fires and forgets — `sendMail(...)` returns `{ sent: false, reason }` and only
  the requests route even looks at it (`listings.ts:461`, to stamp `notified_at`).
- `sendViaCloudflare` catches everything (`sendMail.ts:137-143`), so a rejected recipient becomes
  a `console.error` and an `email_events` row with `ok = 0`. The give/request/choose flow reports
  success either way.
- `email_events.ok = 1` records *acceptance*, not *delivery*. There is no bounce webhook, no
  complaint feedback loop, and nothing that reads `email_events` on a schedule. The founder cannot
  observe his own bounce rate from his own data; Cloudflare scores the domain from 2% and he would
  find out by being throttled.

**Worst case, ranked by likelihood:** most likely is that it works and a few percent bounce
invisibly. Next most likely — and the reason this is a must-fix — is that the binding refuses
non-verified destinations, in which case *no giver ever hears that someone asked for their
keepsake* and *no chosen requester ever hears they were chosen*, while every screen says the
action succeeded. That failure mode is indistinguishable from working, from the inside.

**Fix, in order:**
1. Before attaching the domain, set production to `EMAIL_MODE=allowlist` with a second address
   that is *not* a Cloudflare-verified destination (a fresh Gmail), run one request and one
   choose, and confirm `email_events.ok = 1` **and** that the mail physically arrives. Then flip to
   `live`. This is the one test that has never been run.
2. Make a failed send visible: have the request and choose handlers surface `{ sent: false }` to
   the giver's dashboard ("we couldn't reach your email address") rather than discarding it.
3. Add a weekly read of `email_events` grouped by `ok` and `error` to the admin page. It is one
   query, and it is the only bounce signal that will ever exist.

### 4. Nothing tells anyone the Worker is broken. [observed]

`.github/workflows/` contains exactly two files and neither has a `schedule:` trigger. There is no
uptime check, no alert rule, no error notification, no on-call anything —
`docs/runbooks/incident.md:43` says so in as many words. `/health` is well built and correctly
polled *by the deploy job for two minutes after a deploy*, and by nothing else ever again.

Worse, `/health` would not catch much anyway: `ok` is `bindingsOk && d1 === "ok"`
(`apps/api/src/index.ts:84`), and every binding other than D1 is a presence check
(`apps/api/src/env.ts:30-37`). R2 refusing writes, KV erroring, Workers AI down, or Email Service
rejecting every send all still report `ok: true` with `"BUCKET":"ok","AI":"ok","EMAIL":"ok"`, which
is exactly what preview returns right now. `degraded` sounds like a health signal but means only
"`ENVIRONMENT` is production and `TURNSTILE_SECRET` or `ADMIN_TOKEN` is unset".

Client-side is worse still: **`@sentry/react` is not a dependency and no Sentry code exists under
`apps/web`**, despite `docs/design/ops.md:39` claiming otherwise. `EXPO_PUBLIC_SENTRY_DSN` is
plumbed through `deploy.yml:64` into a build that reads it nowhere. A JS exception that blanks the
page for every visitor produces zero telemetry anywhere.

**Fix (an hour, total):** point any free uptime monitor at `https://keepsake.ing/health` with a
JSON assertion on `ok`, alerting to the founder's phone. Set `SENTRY_DSN` on the production Worker
— it is currently listed as "optional" in the cutover checklist — and prove one event actually
lands, via a temporary `adminAuth()`-guarded throwing route; the existing `test/sentry.test.ts`
only asserts the return value of a pure function and cannot tell you whether anything is received.
Then make `/health` do a real R2 `head` and a KV read so `ok` means something.

**Superseded 2026-09-06 (issue #14):** `SENTRY_DSN` was never set — it needs a Sentry account only
Kiarash can create, which is exactly the "provision a secret" step this section recommended and
the reason it never happened. Rather than wait on that account, Sentry was replaced outright with
Workers Logs (`[observability]` in `wrangler.toml`, no secret involved), and the "temporary
throwing route" this section imagined is now a permanent, named diagnostic —
`POST /api/admin/test-error` — see `docs/runbooks/admin.md`. `test/sentry.test.ts` is deleted;
its successor test file exercises the real capture path the same way. `/health`'s real R2/KV
checks landed separately and are unaffected by any of this.

### 5. There is no restore path for the production database. [observed]

A repo-wide search for `backup|time.?travel|restore|d1 export|point.in.time|versioning` returns
zero operational hits. `docs/runbooks/incident.md` has no data-loss section at all. **D1 Time
Travel — the founder's actual recovery mechanism, on by default with 30 days of retention — is
mentioned nowhere**, though the pinned `wrangler 4.129.0` ships both `d1 time-travel` and
`d1 export`. He would have to discover it mid-incident, from Cloudflare's docs, under pressure.

R2 has no versioning or lifecycle rule (`wrangler.toml` declares only `binding` and
`bucket_name`), and `orphanSweep` calls `BUCKET.delete()` unconditionally
(`cron/orphanSweep.ts:54-55`). A bug in that `WHERE listing_id IS NULL AND created_at < ?`
predicate destroys user photos permanently — Time Travel would restore the rows but not the bytes.

**Fix:** three lines in `incident.md` giving the exact `wrangler d1 time-travel restore` and
`d1 export` invocations for `keepsake-db-production`, and one scheduled workflow that runs
`d1 export` weekly into R2. That converts "unbounded, possibly total" into "twenty minutes".

### 6. The admin token can be brute-forced without limit. [observed]

`apps/api/src/routes/admin.ts:40` is `adminRoutes.use("*", adminAuth(), burst("RL_ADMIN"))` — auth
first. `adminAuth` returns via `fail(...)` without calling `next()`, so on a *wrong* token
`burst("RL_ADMIN")` never runs. 150 requests to `/api/admin/stats` with distinct wrong tokens from
one IP inside 60 s, against a binding configured at `limit = 120, period = 60`, returned **150×401
and 0×429**. `docs/runbooks/admin.md:27` asserts the opposite.

The compare itself is genuinely constant-time and the token is a strong secret, so this is not an
imminent breach — but it is an unmetered, unlogged, un-alerted guessing channel against the single
credential that can hide listings and ban owners, on an endpoint that is easy to find.

**Fix:** swap the two — `adminRoutes.use("*", burst("RL_ADMIN"), adminAuth())`. One line. While
there, note that the 401 body distinguishes `"Admin is not configured."` from `"Invalid admin
token."` despite the comment at `adminAuth.ts:11` claiming it does not; make both the same string.

### 7. The published privacy policy contains two false statements, no minimum age, and no controller. [observed]

This is the founder's personal liability, and the product ships to `US`, `CA` and `GB`
(`packages/contracts/src/geo.ts:8`), so UK GDPR and PIPEDA are in scope, not just Texas law.

**Two statements that are false today:**

- `privacy.html:93-97` states as present-tense fact that Cloudflare Web Analytics is in use.
  `apps/web/src/lib/analytics.ts:12-16` is a no-op whose own header says "no analytics provider
  wired yet". Confirmed on the wire: neither `/` nor an item page loads any third-party script;
  the only absolute URL in either document is the site's own origin. Harmless privacy-wise
  (over-disclosure), but it is a false factual claim in a published policy.
- `privacy.html:88-90` says the IP hash "can't be reversed back into one". A day-salted SHA-256
  over a 2³² IPv4 space with a known salt is pseudonymised, not anonymous. And
  `apps/api/src/middleware/rateLimit.ts:45` omits the day entirely —
  `sha256Hex(clientIPFrom(c.req.raw))` is a bare, stable-forever digest of the address, which is
  precisely the long-term identifier the day-salt elsewhere exists to prevent
  (`listings.ts:344-346` explains the rule the one path that breaks it ignores).

**Three things missing that a solo founder should not launch without:**

- **No minimum age, anywhere.** Neither page mentions age, minors, or children — on a product with
  photo upload, free-text stories, and a flow that explicitly contemplates "arranging to meet a
  stranger" (`terms.html:88-91`). This is the single most serious structural gap. No COPPA floor,
  no UK Age Appropriate Design Code consideration.
- **No named data controller and no postal address.** Only `hello@keepsake.ing`. UK GDPR Art. 13
  requires controller identity and contact details; no legal entity is named on any page.
- **No disclosure that the giver's own email address is handed to the requester.**
  `email/templates/chosen.ts:22` puts it in the body as a `mailto:` and `routes/me.ts:161` sets it
  as `replyTo`. The privacy page discloses the reveal in one direction only and tells the giver
  their address is "never shown publicly" — true, and the opposite of the impression a giver forms
  before clicking "choose".

**Fix:** delete or ship the analytics claim; rewrite the IP sentence as "pseudonymised" and add
the day salt to `rateLimit.ts:45` so the code matches the page's own worked example; add a minimum
age to the terms; name a controller and an address; add one sentence to the privacy page about the
choose flow revealing the giver's address. Also disclose Turnstile (Cloudflare receives the user's
IP — `middleware/turnstile.ts:51`), Sentry, Resend, the postcode and lat/lng stored per listing,
and that photos are sent to an AI model to *generate a title and category*, not only to screen
them (`suggest/suggest.ts:85` — `privacy.html:79-84` covers only the safety use).

---

## Fix in the first week

### 8. A successful launch day and an attack look identical, and neither pages anyone. [code]

`MOD_TEXT_DAILY_BUDGET = 1000` is a *global* counter, checked once per listing
(`moderation/pipeline.ts`, step 2). So the whole platform can moderate 1000 listings per UTC day.
Listing 1001 stays `pending`, gets retried by the 5-minute cron, and after `MAX_ATTEMPTS = 3` —
about fifteen minutes — is escalated to `needs_review` and lands in the admin queue, invisible to
the public, with `held_for_review`.

A front-page link does that. So does an attacker: `LISTING_IP_DAILY_BUDGET = 20`, so roughly 50
addresses exhausts the day's text budget, and an IPv6 /64 supplies those for free. From that
moment every genuine listing posted for the rest of the UTC day silently parks in the admin queue.
Nothing alerts, and the giver just sees "reviewing".

Related, and worth correcting because the comment is misleading: `MOD_IMAGE_DAILY_BUDGET = 3000` is
also charged **once per listing**, not once per image, while the pipeline then makes up to five
vision calls. The real ceiling is 15,000 inferences/day, five times what the configuration reads.

**Fix:** raise the global ceilings and put a floor under them — reserve a slice of the daily budget
that per-IP-exhausted callers cannot reach — and, more importantly, emit a captured warning when
either global budget is first exhausted in a day (`alertBudgetExhaustedOnce`,
`moderation/pipeline.ts` — done, and since issue #14 that capture goes to Workers Logs rather than
Sentry). Right now the only symptom is a queue filling up that nobody is watching.

### 9. `RL_READ` is declared in all three environments and used by nothing. [observed]

`grep -rn 'burst(' apps/api/src` returns eight call sites; `RL_READ` is not among them — it
appears only in a comment. So `/api/feed`, `/api/listings/:id`, `/item/:id`, `/i/:id/:variant`,
`/api/geo/*` and `/health` have no rate limiting whatsoever. Confirmed: 320 parallel
`GET /api/feed` requests from one address returned **320× 200**.

Cost is real but not alarming — Workers requests at $0.30/M past the included 10M, plus D1 rows
read — and Cloudflare's own DDoS protection sits in front. The reason it belongs on the list is
the class of bug, which this repo has already recorded twice: a guard that has never once fired.
Wire `burst("RL_READ")` onto the feed and image routes, and separately audit the other seven
bindings for whether they have ever returned a 429 in production.

### 10. The burst limiter is far leakier than its configured number. [observed]

`RL_UPLOAD` is `limit = 10, period = 60`. Seventy sequential `PUT /api/photos` from one address let
**26 consecutive requests through before the first 429**, then oscillated. The KV daily budget
(`UPLOAD_IP_DAILY_BUDGET = 60`) fired correctly and produced the right message. So the KV layer
works and the binding layer is approximate — which is documented Cloudflare behaviour, but the
comments in `wrangler.toml` and `rateLimit.ts` read as if these were hard caps. Size every burst
limit assuming roughly 2.5× leakage, and never rely on one as the only brake.

### 11. `owners` rows are minted before any limiter and are never swept. [code]

`photoRoutes.put("/", ownerAuth({ createIfMissing: true }), burst(...), dailyBudget(...))` —
`ownerAuth` runs first, so a request that is subsequently 429'd or 400'd has *already* inserted an
`owners` row for whatever random `ks_…` token it presented. Combined with finding 10 that is on
the order of 37k rows/day from a single address, and `orphanSweep` deletes photos, tokens and
events but never owners. Nothing else does either — there is no delete-account path anywhere.

Not an emergency (rows are small; D1's ceiling is 10 GB) but it is unbounded, permanent junk in
the table every owner lookup queries. Move `createIfMissing` after the limiters, or sweep
`owners` rows with no listings, no email and no activity after 30 days.

### 12. Cron failures are invisible, including to Sentry. [code]

`apps/api/src/index.ts:149-160` dispatches both crons through `ctx.waitUntil(...)` and returns.
Sentry's scheduled instrumentation wraps the handler, which has already resolved — so a rejection
inside `orphanSweep` or `moderationRetry` is a detached unhandled rejection nothing catches, and
the instrumentation's `finally` disposes the client while the job is still running. The heartbeat
(`cron:last:<name>` in KV) is written correctly as the last statement of each job and exposed by
`GET /api/admin/health` — but `AdminHealth` is **never rendered on the admin page**, and
`AdminHealth.ok` is derived solely from `postal_codes_count > 0`, so a month-old timestamp does
not make it false.

`moderationRetry` also loops `await moderateListing(...)` over 50 candidates with no per-item
try/catch: one poisoned listing aborts the batch, skips the heartbeat write, and repeats
identically every five minutes forever, in silence.

**Fix:** `await` the job inside `scheduled` (or attach a `.catch(Sentry.captureException)` before
handing it to `waitUntil`), wrap each `moderateListing` call, and render `cron_last_run` on the
admin page with a red state past 24 hours.

### 13. The admin queue at 200 items is a lost evening. [code]

Pagination is correct (keyset cursor, `LIMIT`), but pages accumulate in the reducer and all render
with no virtualization — 200 cards, up to 1000 thumbnails in the DOM. The queue endpoint is N+1 by
four (`admin.ts:134-153`): photos, owner, full moderation history and all reports, per row —
roughly 810 D1 queries to page through 200 items. The stats strip does three full-table `COUNT`s
and is re-fetched after *every single action*. There are no bulk actions: every route is
single-`:id`, and hide/reject/ban each require opening a reason sheet.

At a realistic 15-30 s of human judgment per item that is 1.5-2.5 hours in one unbroken sitting,
with the UI degrading as it goes. This is the operational cliff behind finding 8: whatever fills
the queue, clearing it is the founder's whole night.

**Fix, cheapest first:** stop re-fetching stats after every action; add "approve" as a
one-keystroke action; add a bulk-reject for a selected set. The N+1 can wait.

### 14. Turnstile dead-ends the user when the widget fails. [observed on preview]

`apps/web/src/ui/Turnstile.web.tsx:92` — `"error-callback": () => onTokenRef.current("")`. Empty
string is the repo's sentinel for "no site key configured, proceed" (`lib/config.ts:15-18`), so a
widget that fails to load — an ad blocker, Brave shields, a flaky network — *enables* the submit
button and posts a token the server must reject, producing "Please complete the verification and
try again" with no verification widget on screen to complete. The expiry callback
(`:88`) resets the widget but never clears the stored token, so submitting after five minutes
sends a dead one.

Both are live on preview: the site key `0x4AAAAAAEqUUMHIymlBJ3pb` is present in the deployed
bundle and `Turnstile.web.tsx` is unmodified in the working tree, so neither is fixed yet. See the
known-unfixed section below for the launch call.

### 15. Photos of rejected, withdrawn and hidden listings are kept forever. [code]

`orphanSweep` only ever sees photos with `listing_id IS NULL` (`orphanSweep.ts:46`). Withdraw,
given, admin-reject and admin-hide all mutate `listings.status` only, leaving `photos.listing_id`
set — so those R2 objects are never swept by anything. `privacy.html:74-77` promises they are kept
"for as long as the listing exists, plus a short grace period after it's removed"; the grace period
does not exist in either direction, and rejected photos outlive everything.

Owner-initiated *delete* is correct and does remove the bytes (`listings.ts:222-233`, R2 first,
row second) — that part is fine.

### 16. A requester has no way to remove their data. [code]

`requests` rows store the requester's **raw email, raw phone, free-text note and IP digest**
(`0001_init.sql:37`) for the entire life of the listing, with no expiry and no sweep. A requester
holds no owner token and has no dashboard; the privacy page's deletion section is written entirely
from the giver's perspective. `DELETE /api/me/email` only nulls the column — there is no
delete-account endpoint for anyone, and no admin tooling to service the "write to us and we'll take
care of it" promise.

Also unverified and worth a positive control before launch: `listings.ts:229` banks on
`ON DELETE CASCADE` firing in D1. If foreign keys are off for that database, deleting a listing
leaves orphaned `requests` rows carrying raw emails and phone numbers that no sweep can see.

### 17. No security headers at all. [observed]

`curl -sI` on the app HTML returns no `Strict-Transport-Security`, `X-Content-Type-Options`,
`Referrer-Policy`, `X-Frame-Options`/`frame-ancestors`, `Permissions-Policy` or CSP. Low
exploitability here — user images are magic-byte sniffed and served with a fixed safe
content-type, so the usual polyglot path is closed — but the recovery link puts a live credential
in a URL (`/recover/<token>`), and framing the give flow or the admin page is currently possible.
Add the five standard headers to `apps/web/public/_headers`; it costs nothing.

### 18. Migrations apply before the Worker deploys. [code]

`deploy.yml:70-74` runs `d1 migrations apply --remote` ahead of `wrangler deploy` at `:76-80`. A
failed deploy leaves a migrated database served by the previous code, with nothing detecting or
reverting it. Survivable because migrations are additive and forward-only, but it is a real
window. Related: `docs/runbooks/deploy.md:76-82` says "there is no separate rollback command" —
the pinned `wrangler 4.129.0` does ship `wrangler rollback` and `wrangler versions list`, which is
much faster than a CI re-run and should be written into the runbook before it is needed. And
`deploy.md:10` and `ops.md:17` both say production deploys on push to `main`; `deploy.yml:32` says
otherwise, correctly. Fix the docs — those are the sentences someone reads at 2am.

---

## Worth knowing

- **The version-skew guard does not exist.** `docs/design/ops.md:47-52` describes it as ported from
  Finderly. Nothing in `apps/web` references `/version.json`; the server half works and nothing
  polls it. A tab open across a deploy runs a stale bundle indefinitely.
- **Two `[vars]` are read by nothing.** `MAX_PHOTOS` and `IMAGE_TRANSFORMS_ENABLED` appear in all
  three environment blocks and are referenced nowhere in `apps/api/src`. The real photo limit is a
  hardcoded `.max(5)` in `CreateListingInput`. Turning `MAX_PHOTOS` down in production would do
  nothing.
- **`COMMIT_SHA = "dev"` is checked into the production var block.** CI overrides it with
  `--var COMMIT_SHA:<sha>`; a hand-run `wrangler deploy --env production` would not, and `/health`
  would report `"dev"` for a real deploy.
- **Llama Guard is lenient on text about objects** — `docs/design/moderation.md` records a story
  describing explicit adult magazines coming back `safe`. Text-side `review` will rarely fire; the
  vision pass and the report button carry borderline cases. The vision prompt bug (the model
  copying a pre-filled example, which made every image score decorative) is fixed and verified
  live, and `S11` self-harm is now handled as `review` rather than falling through
  (`decide.ts:22`) — that one is genuinely closed.
- **The takedown path at 3am is: nobody.** Three independent reporters auto-hide a listing
  (`REPORT_AUTOHIDE_THRESHOLD = 3`) and fire `Sentry.captureMessage` — which was a no-op with no
  DSN set. Below three reports, the only route is the admin page, and only the founder has the
  token. Realistically: minutes if he is awake and sees it, hours if he is not, and there is
  currently no notification that would wake him. **Superseded 2026-09-06 (issue #14):**
  `Sentry.captureMessage` is now `captureMessage` writing to Workers Logs, which needed no DSN and
  is live unconditionally — the auto-hide message reaches a log line the moment it happens. It is
  still not a page: Workers Logs has no push/alerting on the Free plan, so "nobody is woken up" is
  still true today, just for a different reason (no alerting mechanism at all, rather than an
  unset secret). A Tail Worker or Logpush is the real fix for that half and remains undone.
- **The request note is not moderated and is quoted verbatim into an email.** Listing title and
  story go through the contact-info regex and both AI gates; `requests.note` goes through neither
  and is emailed to the giver (`newRequest.ts:23`). HTML escaping is correct throughout the
  templates, so this is not an injection vector — but it is 20 free-text messages per IP per day
  delivered from `hello@keepsake.ing` to a stranger's inbox, and a requester who types their phone
  number into the note defeats the mask-until-chosen guarantee the privacy page makes.
- **The email subject interpolates the listing title unescaped** (`newRequest.ts:20`,
  `chosen.ts:29`) and `TitleSchema` is `z.string().trim().min(4).max(80)` with no newline
  restriction. Body HTML is escaped; the subject header is not. Probably handled by the provider's
  MIME encoder, but worth one test with a `\n` in a title before launch.
- **Requesting a keepsake that was just given returns "Listing not found."** The item page
  correctly hides the button for `given` (`app/item/[id].tsx`), so this needs a race — the page
  loaded before the handoff, submitted after. Rare, and the copy is wrong rather than broken.
- **The edge cache may outlive deletion.** `/i/:id/full` is `public, max-age=31536000, immutable`
  and nothing purges `caches.default` when a listing is deleted. R2 deletion is real; the cached
  copy is not addressed.
- **`Disallow: /admin` in robots.txt advertises the admin path** to anyone who reads it. The token
  gate is what matters, but combined with finding 6 the endpoint is both findable and unthrottled.
  **Fixed 2026-09-07 (issue #84):** the line is gone from `apps/web/public/robots.txt`; `/admin` is
  kept out of search results instead by an unconditional `X-Robots-Tag: noindex` on that path in
  every environment (`apps/api/src/index.ts`), which doesn't require telling anyone where to look.
- **`/mine` with no token is good.** "You haven't given anything yet… Once you give something,
  it'll show up here" with a "Lost your listings?" link. That is the right sentence for a first
  user, and every other dead end I walked reads like a human wrote it: a missing item says "That
  keepsake isn't here — it may have already found a home, or the link might be off"; an expired
  recovery link says "This recovery link is invalid or has expired"; a bad verify token redirects
  to `/mine?verified=0&reason=expired` rather than showing a raw error. This section of the audit
  is short because there was little to find.

---

## Preview vs production: every difference in `apps/api/wrangler.toml`

**Deliberate and correct:** `ENVIRONMENT`, `SITE_URL`, and separate `database_id`, `bucket_name`,
KV `id` and rate-limit `namespace_id`s (2xxx vs 3xxx) per tier. Preview abuse cannot touch
production data. The bindings (`AI`, `EMAIL`, `ASSETS`, `run_worker_first`) are restated verbatim
in each block, which is required — Wrangler does not inherit them — and they match.

**Deliberate, but the thing to watch:** `EMAIL_MODE` `allowlist` → `live` and `EMAIL_ALLOWLIST`
`kiarasha@alum.mit.edu` → `""`. This is the only behavioural difference between the two
deployments, and it is the one place preview proves nothing about production. See finding 3.

**Identical in both, and that is the accident waiting:** every budget and every rate limit. The
numbers are the same in development, preview and production, which means (a) nothing preview has
ever done has tested a production ceiling, and (b) the global moderation budgets that will govern
launch day were sized against zero traffic. `MOD_TEXT_DAILY_BUDGET = 1000` is a hard platform-wide
cap of 1000 listings per UTC day; `LISTING_IP_DAILY_BUDGET = 20` is per address, which an IPv6
range makes meaningless; `MOD_IMAGE_DAILY_BUDGET = 3000` is charged per listing but spends up to
five inferences. See findings 8 and 9.

**Cosmetic but wrong:** `COMMIT_SHA = "dev"` in the production block, and `MAX_PHOTOS` /
`IMAGE_TRANSFORMS_ENABLED` in all three blocks reading as configuration while being read by
nothing.

---

## The three known-unfixed give-flow bugs: which block launch

| Bug | Launch blocker? | Why |
|---|---|---|
| **No page scrolls** | **Yes.** | Measured live: 745 px of the feed and 133 px of every item page are unreachable on a 390×844 phone, wheel gesture moves 0 px. This is not a degraded experience, it is the product being unusable on the device most first visitors will use. Finding 1. |
| **Review step shows no photo** | **No.** | The give flow completes and the listing posts correctly with its photos. A giver confirming "is this right?" against a photo count instead of a photo is a real trust cost on the most important screen in the funnel, and it should ship in the same change as the scroll fix — but it does not stop anyone. |
| **Expired verification token → confusing error** | **Borderline — fix the error-callback half.** | The expiry path (leave the review screen open six minutes, submit, get "Please complete the verification and try again") is recoverable by reloading, and is annoying rather than fatal. The *other* half of the same file is worse and is not on the list: `"error-callback": () => onTokenRef.current("")` enables submit whenever the widget fails to load, which for anyone behind an ad blocker is a permanent dead end on the final step of the give flow, with an error message that asks them to complete a widget that isn't there. Finding 14. At minimum the copy must say "reload the page and try again"; better, fix both callbacks together. |

Since all three are on the same branch with the scroll fix, the practical answer is: land the
branch, then re-verify each against the deployed build — the scroll measurement with `/privacy` as
the control, an image visible on the review step, and a submit attempt with the Turnstile script
blocked in devtools. None of the three has a test today that could fail.

---

## What is fine, and I checked

- The `/item/:id` Open Graph injection escapes every field, serves an unmodified 404 shell for
  anything not `approved`/`given`, sets `no-store`, and removes the shell's default tags first.
  Nothing in the tags exceeds what the page already shows — no postcode, no coordinates, no owner.
- The moderation pipeline fails closed: any AI error or malformed parse leaves the listing
  `pending`, and the status update is guarded by `WHERE version = ?` so an edit racing the pipeline
  cannot be approved against stale content.
- Contact masking is correct in both directions until `status === "chosen"` (`me.ts:34-46`).
- The admin token compare is genuinely constant-time and visits `max(len)` bytes.
- The admin token is in `sessionStorage`, not `localStorage`, with a written rationale, and is
  cleared on 401.
- Owner tokens are never stored raw — only `sha256` — and recovery correctly rotates the owner
  token and kills the old one.
- `POST /api/recover` returns 200 regardless of whether the address matches, so it cannot be used
  to enumerate who has a Keepsake dashboard.
- Photo bytes are magic-byte sniffed, not trusted from the multipart content-type, and the served
  content-type comes from the sniff.
- Owner deletion of a listing really does delete the R2 objects, R2 first and the row second.
- The capture redaction layer (`@keepsake/observability/redact`, originally built for Sentry and
  carried over unchanged when issue #14 replaced it with Workers Logs) strips `?token=`, `Bearer`,
  `owner_token`, `cf-turnstile-response` and `idempotency-key`. There is no session replay and
  never was — Workers Logs has no such feature to disable.
- No cookies are set anywhere, on any route — the privacy page's "no tracking cookies, no ad
  pixels, no ads" is true, and confirmed on the wire.
- No third-party script loads from the browser except Turnstile.
- Postcode lookup is a local D1 query against a GeoNames seed. No reverse-geocoding provider is
  contacted; the GeoNames attribution in the footer is accurate.
- The KV daily-budget layer works on the real stack — I watched `UPLOAD_IP_DAILY_BUDGET` deny with
  the right message and a correct `retryAfter`.
- Production deploy is genuinely `workflow_dispatch`-only, whatever the runbooks say.

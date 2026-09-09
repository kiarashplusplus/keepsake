# Runbook: admin

Status: `[DONE]`, both halves. API side 2026-09-06 — `src/routes/admin.ts` +
`src/middleware/adminAuth.ts`, tests in `test/admin.test.ts`, `test/adminAuth.test.ts`,
`test/ownerAuth.test.ts`, `test/orphanSweep.test.ts`. **The `/admin` page exists too**
(`apps/web/app/admin.tsx` + `src/features/admin/`: token gate, queue cards, bulk actions, reason
sheet, stats strip, and the Observatory panel from #150) — this line used to say it was "a
separate, not-yet-started piece of M4/M5", which stopped being true when #11 shipped the queue.
Everything below is the API; the page is a client of it, and `curl` remains a first-class way to
drive every one of these routes.

Kiarash is the only admin. Auth is a single secret (`ADMIN_TOKEN`), sent as
`Authorization: Bearer <ADMIN_TOKEN>` and compared constant-time — there is no admin user table
row, no session, no second admin.

## Access

Web: `/admin` prompts for the token, stores it in `sessionStorage` only (cleared on tab close —
deliberately not `localStorage`, since this is the one credential in the app that grants access
to everything). API: any `Authorization: Bearer <ADMIN_TOKEN>` request to `/api/admin/*`.

### Where a session gets the token

**Both tokens are written down in `AGENTS.md`, under "Admin tokens".** That is a deliberate
decision for this private repo (2026-09-07): a session — local, phone, or claude.ai — should be
able to read the Observatory without asking a human for a credential first. A claude.ai session
in particular has only the repository, so a token that lives anywhere else is a token it cannot
use.

The two tiers do **not** share a token, and nothing in the response tells you which one you are
holding: a production token against preview is an ordinary `401`, indistinguishable from a typo.

What follows from writing them down, and what the rest of this runbook assumes:

- **Rotation is now two steps, not one.** `wrangler secret put ADMIN_TOKEN --env <tier>` changes
  what the Worker accepts; the table in `AGENTS.md` has to change in the same breath or every
  session is holding a dead token. And the old value stays in git history — rotating makes it
  useless, it does not erase it.
- **Rotate both before this repo becomes public or gains a collaborator who should not have
  admin.** These tokens reach real givers' email addresses through
  `GET /api/admin/requests/:id`; that is the exposure to reason about, not the tier name.

`ADMIN_TOKEN` itself is still a Worker secret and is still set with `wrangler secret put` — what
is committed is the value a session presents, not the Worker's configuration. Every other
credential remains outside the repo.

Rotate with:

```sh
wrangler secret put ADMIN_TOKEN --env production
```

Rotating invalidates every open admin session immediately (no server-side session to migrate) —
expected, not a bug, if rotation follows a suspected leak (see `docs/runbooks/incident.md`).

All `/api/admin/*` routes are behind the `RL_ADMIN` rate-limit binding (120/60s, `wrangler.toml`)
**before** `adminAuth()` runs — `adminRoutes.use("*", burst("RL_ADMIN"), adminAuth())`. The order
is the whole point and it is worth stating plainly, because this file used to assert the
protection while the code did the opposite: with `adminAuth()` first, a wrong token was answered
by `fail(...)` and never reached the limiter, so token guessing was unmetered (the 2026-09-06
launch audit measured 150 wrong tokens from one IP inside 60s returning 150x401 and 0x429). With
the limiter in front, the 401 path costs an attacker exactly what the 200 path costs. Both halves
— the count and the ordering — are pinned by tests in `apps/api/test/adminAuth.test.ts`.

Every 401 from `/api/admin/*` carries the same body (`"Invalid admin token."`) whether the token
is wrong or `ADMIN_TOKEN` is unset, so the response never reveals whether admin is configured.

## Queue

`GET /api/admin/queue?status=<needs_review|hidden|pending|rejected>&cursor=&limit=` — one status
per call (not tabs merged server-side; the web page is expected to make one call per tab).
Paginated with the same opaque keyset-cursor shape `GET /api/feed` uses, but ordered by
`updated_at DESC` rather than `published_at` — what an admin wants triaged first is whatever
last changed. Each item is every `OwnerListing` field (title, story, photos, status, …) plus:

- `owner: { id, email_masked, email_verified, banned }` — never the raw email.
- `report_count`.
- `events: [{ kind, model, verdict, flags, reason, attempt, latency_ms, created_at }, …]` — the
  full `moderation_events` log for that listing, `flags_json` parsed. The reasoning trail, not
  just the current status.
- `reports: [{ reason, details, created_at }, …]` — no `ip_digest`, no other reporter identity.

## Actions

| Action | Effect |
|---|---|
| `POST /api/admin/listings/:id/approve` | `needs_review`\|`pending`\|`hidden` → `approved`; sets `published_at` if not already set |
| `POST /api/admin/listings/:id/hide` | any status except already-`hidden` → `hidden`; optional `{ reason }` in the body |
| `POST /api/admin/listings/:id/restore` | `hidden` → `approved`; resets `report_count` to 0 so it isn't instantly re-hidden by the same reports |
| `POST /api/admin/listings/:id/reject` | any status except `given` → `rejected`; body `{ reason }` must be one of `ADMIN_REJECT_REASONS` (`@keepsake/contracts/admin`) — the giver-facing subset of `MODERATION_REASON_CODES`, excluding the internal-only `budget`/`held_for_review` |
| `POST /api/admin/owners/:id/ban` | sets `banned_at`/`ban_reason`; hides every one of the owner's listings that isn't already `given`; every owner-route request from that owner 403s from then on |
| `POST /api/admin/owners/:id/unban` | clears `banned_at`/`ban_reason` only — listings the ban hid stay hidden until individually restored |
| `GET /api/admin/listings/:id` | one listing by id, enriched exactly as a `GET /api/admin/queue` item (photos, aspects, masked owner, `moderation_events`, reports). Not status-filtered, so it finds `given`/`withdrawn`/`rejected` listings the queue's tabs cannot show — which is what an id forwarded by a giver, or pulled off a report, usually turns out to be |
| `GET /api/admin/requests/:id` | one request's `note`/`email`/`phone`/`status`/`age_attested_at` plus its parent listing's `id`/`title`/`status` — a targeted, on-demand lookup, not a queue field (see "Minors" section below) |
| `POST /api/admin/requests/:id/remove` | redacts that request's `note`/`email`/`phone` (`status` → `removed`), decrements the listing's `request_count`; doesn't touch the listing itself; optional `{ reason }` in the body; 409s if already `withdrawn`/`removed` |
| `GET /api/admin/stats` | listing counts by status, requests today, email failures today, today's `mod_text`/`mod_image` AI budget usage (KV `budget:<kind>:<day>`) |
| `GET /api/admin/health` | `ok`, `postal_codes` row count (warns if 0), **`503` when `ok` is false**, matching public `/health` — so a monitor reads the status code rather than parsing the body. The envelope stays `{"ok": true, "data": {…}}` (the request succeeded; only the verdict is red), which is what keeps `/admin`'s token gate working when the site needs attention. `cron_last_run` for all **five** registered crons (`moderationRetry`, `orphanSweep`, `searchIndexRetry`, `dailyDigest`, `bulkRunner`, from KV — the list is whatever `src/cron/registry.ts` holds, so don't restate a count here that a new cron makes wrong) and `report_pressure` (auto-hidden listings awaiting review — which also flips `ok` — plus listings one report from the threshold) |
| `POST /api/admin/test-email` | sends a real message through the real `sendMail()` path to `{ to }` and reports back `{ sent, reason, provider }` — see below |
| `POST /api/admin/test-error` | **diagnostic only, not product API** — deliberately calls `captureException`/`captureMessage` (`{ kind: "exception" \| "message" }`, defaults to `"exception"`) so a real event can be confirmed in Workers Logs / `wrangler tail`. Returns the `request_id` it tagged the event with: every invocation writes the same message, so that id is the only thing that tells your event from the last one — search for it rather than for the message — see below |

Every listing action writes a `moderation_events` row with `kind='admin'` — the admin queue's own
history is itself an audit log, not just a UI convenience.

## Minors: actual-knowledge takedown rule

**The rule:** the moment you have actual knowledge that a specific user is under 18 — from a
report, a listing's own story text, a request note, or anything else — remove the content and ban
that person's device token. Do not wait for a second signal, and do not treat the 18+ attestation on
file for that listing/request as reason to doubt what you were just told; the attestation is
evidence the platform had no *prior* knowledge, not a reason to disregard *new* knowledge.

This exists because Montana's Consumer Data Privacy Act (MCA §30-14-2811) imposes a duty of care
on any controller as to a consumer "whom the controller actually knows or willfully disregards is a
minor," with **no volume threshold** gating that duty (unlike the rest of the MTCDPA) — confirmed
directly against the statute text at `mca.legmt.gov`, not inherited from search-summary text.
**Willful disregard is having the signal and not acting on it** — which is what "no written rule"
meant before this section existed. The 18+ attestation (`AgeAttestationSchema`/`MINIMUM_AGE`,
recorded as `age_attested_at` on both listings and requests) is what keeps Keepsake out of "actual
knowledge" *by default*; this rule is what to do the moment that default is overridden by a
specific fact.

**A separate, unrelated project (#64) is changing the age-gate checkbox to a neutral date-of-birth
field in the give/request flow.** That's an evidentiary improvement on the *no prior knowledge*
side and has nothing to do with this rule — don't touch the give flow for this issue.

### What "the rebuttable presumption" in the statute's section heading actually is

The original research flagged MCA §30-14-2811's section heading — "Duties of controllers — duty of
care — **rebuttable presumption**" — as unresolved, and speculated it might be an age-determination
safe harbour. **Checked directly against the statute text at `mca.legmt.gov`: it is not.** The
presumption is procedural and applies only in an attorney-general enforcement action under
§30-14-2817: *"there is a rebuttable presumption that a controller used reasonable care as required
under this section if the controller complied with this section."* It presumes **compliance with
the reasonable-care standard**, contingent on complying with the section's other substantive
requirements (targeted-advertising/data-sale/profiling consent and precise-geolocation limits for
known minors) — it says nothing about how to determine whether someone is a minor in the first
place, and does not change or soften the takedown rule above.

### Is this actually executable today? Checked against the live admin API — yes, both sides

**Giver side (listings + the owner who posted them): yes, in one call each.**
`POST /api/admin/listings/:id/hide` (or `/reject` if still pre-`given`) removes the content;
`POST /api/admin/owners/:id/ban` bans the owner's device token (`owners.token_hash`) and hides every
other listing of theirs that isn't already `given`. Both are real, tested endpoints (see Actions
above) — no manual DB work needed.

**Requester side: yes, as of #70, in two calls.** The gap this section originally described — no
admin visibility into a request's note, and no way to remove a single request without hiding or
rejecting the whole listing — is closed:

1. `GET /api/admin/requests/:id` — looks up one request by id: its `note`, `email`, `phone`,
   `status`, `age_attested_at`, and the parent listing's `id`/`title`/`status` for context. Not
   masked (see `packages/contracts/src/admin.ts`'s `AdminRequestView` doc comment for why): the
   giver already sees the same raw email/phone once they choose a request, so showing it to the one
   admin who already has D1 access isn't a new class of exposure, just a better-audited path than a
   manual query.
2. `POST /api/admin/requests/:id/remove` — redacts that one request's `note`/`email`/`phone`
   (`status` → `removed`), decrements the listing's `request_count`, and logs a `moderation_events`
   row (`kind='admin'`, `verdict='request_removed'`, the new `request_id` column pointing at the
   request). Distinct from `withdrawn` (the requester's own action via
   `POST /api/requests/withdraw`) so the owner's dashboard doesn't misattribute an admin's removal
   to the requester — it shows "(removed by Keepsake)" instead of "(withdrawn — removed by the
   requester)". 409s (not an idempotent 200) if the request was already `withdrawn` or `removed` —
   there's nothing left to redact, and a silent success there is exactly the "removal endpoint
   no-ops on a bad id" bug class this file's five-checks table warns about.

Both routes sit on `adminRoutes`, so they inherit the same `burst("RL_ADMIN")` + `adminAuth()`
mount as every other `/api/admin/*` route — no separate wiring needed.

**Deliberately not built: a device-token ban for requesters.** The written rule says "ban that
person's device token," but a requester never has one to ban. `POST /api/listings/:id/requests`
(`apps/api/src/routes/listings.ts`) has no `ownerAuth()` and never touches a Bearer token — a
requester is identified only by `email`/`phone`/`ip_digest`, confirmed by reading the route, not
assumed from the schema. Minting a new persistent device-bound secret for the anonymous request
flow, purely so it could later be revoked, would be inventing tracking infrastructure for a product
whose whole posture is minimal collection and no accounts — a bigger privacy cost than the gap it
would close. For a requester, "remove the content" (endpoint 2 above) is the entire action the rule
can mean; there is no device-side half missing, because there was never a device-side identity to
begin with. If a specific email turns out to need blocking from *future* requests (repeat abuse,
not a one-off), that's a separate, larger change (touching the duplicate-request check in
`listings.ts`) and hasn't been built — no case has needed it yet.

**Moderator workflow, given a specific request (e.g. a giver forwards one to Kiarash) or an id from
a report:**

```sh
# See the note and contact info before acting
curl -s "$SITE_URL/api/admin/requests/$REQUEST_ID" -H "Authorization: Bearer $ADMIN_TOKEN" | jq

# Remove it — redacts note/email/phone, does not touch the listing
curl -s -X POST "$SITE_URL/api/admin/requests/$REQUEST_ID/remove" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"actual knowledge of minor age"}'
```

This is deliberately a look-up-by-id pair, not a `requests` array added to `GET /api/admin/queue`:
a request's note is written by a stranger to the giver, and streaming every note into a browsable
queue by default would be a real privacy change for a product that deliberately holds very little.
A moderator who has been given a specific request looks it up on demand instead.


## Proving email actually works

Launch-audit finding: production had never delivered mail to anyone but Kiarash, and every failure
was swallowed silently — `sendMail()` fails closed (see `docs/design/email.md`), which is correct
for a give/request/choose flow but means nobody would notice a broken sender domain until a real
giver complained. `POST /api/admin/test-email` closes that gap: it's a real send through the real
path (never a stub), to any address, reporting exactly what happened.

`leapkg@gmail.com` is on the preview allowlist (`EMAIL_ALLOWLIST` in `wrangler.toml`'s
`[env.preview.vars]`) specifically so this has a second real inbox to check delivery against — the
`kiarasha@alum.mit.edu` route alone couldn't distinguish "it always worked" from "it only ever
worked for the one address that's also the developer."

```sh
curl -s -X POST "$SITE_URL/api/admin/test-email" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"to":"leapkg@gmail.com"}' | jq
```

`{ "sent": true, "reason": null, "provider": "cf" }` means it went out — check the inbox to confirm
it actually arrived, since "sent" here means "the provider accepted it," not "it was delivered."
`{ "sent": false, "reason": "..." }` (e.g. `blocked_not_allowlisted`, `blocked_email_mode_off`,
`send_failed: ...`) means it didn't, and the reason is `sendMail()`'s own, not a reinterpretation —
see `apps/api/src/email/sendMail.ts`'s `guardRecipient` for what each blocked reason means.

## Proving an error actually reaches Workers Logs

Issue #14 replaced `@sentry/cloudflare` with Workers Logs — no third-party account or secret
needed, but also nothing left to unit-test the delivery of: `test/admin.test.ts` only proves
`captureException`/`captureMessage` were called, the same limitation the old `test/sentry.test.ts`
had for Sentry. `POST /api/admin/test-error` exists to close that gap against a real deployment —
**diagnostic only, never call it from product code or wire a client button to it.**

```sh
curl -s -X POST "$SITE_URL/api/admin/test-error" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"kind":"exception"}' | jq
```

`{ "captured": true, "kind": "exception" }` means the call happened — confirm the event actually
landed with `wrangler tail --env preview` (or the Workers Logs tab in the Cloudflare dashboard)
running at the same time, filtering on `event: "capture"`. `{"kind":"message"}` exercises the
`captureMessage` path at `"warning"` level instead of throwing a synthetic exception.

## Curl recipes

Every call needs `Authorization: Bearer $ADMIN_TOKEN` (constant-time compared server-side;
401 whether the token is wrong or simply unset — the response never says which).

```sh
# Held-for-review queue, newest-changed first
curl -s "$SITE_URL/api/admin/queue?status=needs_review" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq

# Approve a held listing
curl -s -X POST "$SITE_URL/api/admin/listings/$LISTING_ID/approve" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Hide a live listing, with a reason for the audit trail
curl -s -X POST "$SITE_URL/api/admin/listings/$LISTING_ID/hide" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"reported photo looked staged"}'

# Restore a hidden listing (resets report_count)
curl -s -X POST "$SITE_URL/api/admin/listings/$LISTING_ID/restore" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Reject a held listing with a giver-facing reason
curl -s -X POST "$SITE_URL/api/admin/listings/$LISTING_ID/reject" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"not_an_object"}'

# Ban an owner (hides their non-given listings) / unban
curl -s -X POST "$SITE_URL/api/admin/owners/$OWNER_ID/ban" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"repeated spam listings"}'
curl -s -X POST "$SITE_URL/api/admin/owners/$OWNER_ID/unban" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Look up one request's note/contact info (e.g. a giver forwarded it, or a
# report references it) before acting on it
curl -s "$SITE_URL/api/admin/requests/$REQUEST_ID" -H "Authorization: Bearer $ADMIN_TOKEN" | jq

# Remove that one request — redacts note/email/phone, leaves the listing alone
curl -s -X POST "$SITE_URL/api/admin/requests/$REQUEST_ID/remove" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"actual knowledge of minor age"}'

# Dashboard counters / operational health
curl -s "$SITE_URL/api/admin/stats" -H "Authorization: Bearer $ADMIN_TOKEN" | jq
curl -s "$SITE_URL/api/admin/health" -H "Authorization: Bearer $ADMIN_TOKEN" | jq

# The Observatory: traffic, funnel, queue ages, recent errors, today's digest.
# window_days is a closed set — 1, 7 or 30; anything else is a 400.
curl -s "$SITE_URL/api/admin/observatory?window_days=7" -H "Authorization: Bearer $ADMIN_TOKEN" | jq

# Is the Cloudflare half actually wired up, or is it reporting itself off?
curl -s "$SITE_URL/api/admin/observatory" -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '{edge: .edge.state, logs: .logs.state, why: (.edge.reason // .edge.error)}'

# Re-read one listing's cover photo with the CURRENT vision prompt (#141),
# replacing its category and aspects. Reports before/after so you can see what
# changed. Never touches the title or the story — those are the giver's words.
curl -s -X POST "$SITE_URL/api/admin/listings/$LISTING_ID/resuggest" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq

# One batch of the aspects backfill (#37) — for listings that have NEVER been
# looked at. Repeat until `.data.remaining` is 0. It deliberately skips any
# listing that already has aspects, so it is not the tool for "the prompt
# improved"; that is `resuggest` above.
curl -s -X POST "$SITE_URL/api/admin/backfill-aspects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"limit":5}' | jq
```

## The Observatory

`/admin` → **Observatory**, or `GET /api/admin/observatory` above. Three sections, and the
important thing about them is that they fail *separately*:

- **`app`** — listings, requests, the give→get funnel, how long the moderation queue has been
  waiting, the search index, and (plan Stage 5) estate bulk upload's own batches/drafts/operations/
  usage/funnel. Comes from D1, needs no credential, and is always present. If this is missing the
  request 500s, because a Worker that cannot read its own database has nothing to say.
- **`edge`** — request/error counts and CPU quantiles from Cloudflare's GraphQL Analytics API.
- **`logs`** — the Worker's own `console.error`/`console.warn` lines, read back out of Workers Logs.

`edge` and `logs` are each one of three states, and the distinction is the point of the whole
feature: `unconfigured` (no credential — a setup hint, not an alarm), `error` (configured and the
call failed — an alarm, and the state most easily mistaken for "no traffic"), or `ok`. **A panel
showing nothing is never ambiguous.** If you find yourself guessing whether a chart is empty
because nothing happened or because something is broken, that is a bug — file it.

### The search-index panel (#208)

`app.search_index` counts approved listings whose text has no vector in Vectorize —
`listings.vector_indexed_at IS NULL` — and ages the oldest of them. **Zero is the healthy
answer.** A non-zero count is not an outage: #180 made an un-indexed listing still findable by
title and story through full-text search, so what is degraded is ranking, not visibility.

What to do with a number that is not zero:

- **Small, and the age is under an hour or so** — that is the `searchIndexRetry` cron's ordinary
  work. It runs hourly, takes five listings newest-first, and the count should fall on its own.
- **The age keeps growing** — something is refusing the same listings every hour. Check the
  `embed` budget first (`AI budget (embed)` in the digest, or the `budget_exhausted` alert): when
  `EMBED_DAILY_BUDGET` is spent, every re-embed of the day is denied and this backlog is that
  outage's symptom rather than a second incident. It clears itself after midnight UTC. The daily
  digest says so in the alert text when both are true, so the two are never chased as two
  problems (#207).
- **`Semantic search is switched off`** — `SEMANTIC_SEARCH` is `"0"` in that environment, so
  nothing is indexed and there is deliberately no number to read. It is `"1"` in all three today.

The retry is bounded on purpose: five an hour is at most 120 embeds a day against a budget of
2000, so a backlog can never crowd out the create/edit paths a person is actually waiting on. The
honest cost of "newest first" is that a listing which fails *permanently* sits at the back of the
queue while newer failures keep arriving — which is exactly what the age is for. An age that
climbs past a day with a small count is a bug report about one listing, not a retry candidate.

Note `logs` no longer comes from Workers Logs at all (issue #159, step 1): it reads `error_events`,
the table the `keepsake-tail` Tail Worker writes the Worker's own error and warning lines into,
redacted, capped at 60 a minute and swept at 30 days. So the window you ask for is the window you
get — the old 3-day clamp was Workers Logs' Free-plan retention and is gone with it.

Two states worth knowing how to read on that panel:

- **`unconfigured`** means *no tail delivery has ever been recorded in this environment* — not "no
  errors". Until `keepsake-tail` is deployed for that tier and named in its `[[tail_consumers]]`
  block in `apps/api/wrangler.toml`, nothing writes the table, and an empty feed would be a claim
  the endpoint cannot support. The reason string names both things to check.
- **A line reading `error-event volume cap: N line(s) dropped in this minute`** is the per-minute
  ceiling doing its job, and N is what it refused. One of those in a window means something was
  emitting more than 60 error lines a minute; the feed under it is a sample of that, not the whole
  of it.

### The bulk-upload panel (plan Stage 5)

`app.bulk` is estate bulk upload's own "is anything stuck" panel — D1-derived like the rest of
`app`, no credential needed, always present when the feature is reachable. Before this existed,
the bulk API's only failure signal was a giver emailing to ask where their photos went; a pilot
cannot run on that.

**`{"enabled": false}` means `BULK_UPLOAD` is off in this environment** — every deployed tier but
preview today (`apps/api/wrangler.toml`) — and there is deliberately nothing else in the payload.
Same rule the search-index panel above follows: a zeroed block for a feature nobody can currently
reach would read as "bulk is quiet today" rather than the true "bulk is not reachable here", so
there is no number to render at all. `docs/product-decisions.md`'s row on the kill switch is the
place to check before assuming this is a bug.

With `enabled: true`, five sub-objects, read in the order an operator would actually check them:

- **`batches`** — `by_state` (`draft` / `submitting` / `closed` / `cancelled`), `active`
  (`draft + submitting`), and `abandoned_draft`: `draft` batches whose own `expires_at` has already
  passed. Their photos are already being reclaimed by `cron/orphanSweep.ts` on its next nightly
  pass, but the `upload_batches` row itself is never deleted — nobody sweeps it — so this is the
  honest count of batches a giver started and never came back to.
- **`drafts`** — `items_by_state` (`editing` / `ready` / `queued` / `submitted` / `failed`),
  `items_outstanding` (everything except `submitted`), and `photos_reserved`/`photos_stored` —
  `upload_batch_photos` rows where the allowance was charged but the bytes never finished landing in R2
  (`photo_id IS NULL`) versus rows where the upload actually finished. **`items_by_state.ready`
  reads `0` on every environment today, and that is correct, not a bug in the query**: nothing in
  `src/bulk/submit.ts` or `routes/bulk.ts` ever writes `state = 'ready'` — readiness
  (`BatchItemSummary.ready`) is computed live on every read by running the real `CreateListingInput`
  over the assembled item, and it is never persisted with a timestamp. This is also why the plan's
  "first ready item" funnel step is one of the three metrics this schema cannot answer yet (below).
- **`operations`** — `by_status` (`queued` / `running` / `done` / `cancelled`), `active`
  (`queued + running`), **`oldest_active_age_ms`** (the number worth a second look — a depth of 3
  that has been 3 for six hours is the failure this panel exists to catch), and
  `active_stale_lease_recoveries`. That last one is `SUM(bulk_operations.stale_recoveries)` scoped
  to operations still `queued`/`running` — see the migration
  (`20260908072223_bulk_operation_lease_recovery.sql`) for exactly what it counts: only a claim that
  recovered a lease a *previous* invocation set and never released (the Worker was evicted or
  hard-timed-out mid-run), never the ordinary multi-invocation chunking a large batch does on
  purpose every ~3 minutes. Scoped to active operations so one that needed a recovery and then
  finished cleanly doesn't keep this number above zero forever — **a rising count here, among work
  still in flight, means the runner is dying mid-run.**
- **`usage`** — today's `bulk_owner_usage`: `owners_today` (rows for today's UTC date),
  `items_used` / `photos_used` / `suggestions_used` summed across them, and **`owners_at_limit`**,
  the count of callers who have hit at least one of `BULK_OWNER_DAILY_ITEMS` /
  `_PHOTOS` / `_SUGGESTIONS` and whose next write of that kind is refused until UTC midnight. That
  last number is the one worth an alert: it is the shape of "a giver emailed asking why their
  upload stopped". This panel replaced a `grants` one when the admission code was removed — same
  question, asked of the ceiling that is still there.
- **`funnel`** — windowed the same way `app.funnel` is: `batches_started`, `items_submitted`,
  `items_approved`, **`orphan_bytes`** (real bytes — `SUM(photos.bytes_full)` — for finished
  uploads that never got attached to any item in a batch whose fate is already sealed, `closed` or
  `cancelled`; a photo still sitting in a `draft` batch's tray is ordinary in-progress work, not an
  orphan), and a median moderation-latency split, `moderation_latency_ordinary_median_ms` versus
  `moderation_latency_bulk_median_ms` — the plan's "ordinary-versus-bulk processing latency"
  metric, answered honestly because both paths already share the same `moderateListing` call and
  the same `moderation_events` log.

**What an operator should do when a number here is wrong:**

- **`operations.oldest_active_age_ms` is large** (the daily digest alerts past 6 hours,
  `bulk_operation_stuck`, critical) — a giver's estate is not finishing. Look at that operation's
  row directly (`SELECT * FROM bulk_operations WHERE status IN ('queued','running') ORDER BY
  created_at ASC LIMIT 1`) for its `attempts` and `next_attempt_at`; if `cron:last:bulkRunner` in
  `GET /api/admin/health` is stale too, the cron itself has stopped and that is the real incident.
- **`operations.active_stale_lease_recoveries` is above zero** (the digest's `bulk_lease_recoveries`
  warning) — the runner is being evicted or timing out mid-invocation for at least one operation
  still in flight. Check Workers Logs for `bulkRunner: operation failed` lines around the affected
  operation id (the message field is redacted — see "Log hygiene" below — so cross-reference by id,
  not by message content) and treat it as a platform-level symptom (CPU limits, a hung fetch inside
  `moderateListing`), not a data problem.
- **`drafts.photos_reserved` stays non-zero for a while** — a giver was charged for a
  photo whose bytes never finished storing (an evicted `PUT /api/bulk/batches/:id/photos/:id`
  mid-upload). A retry of the same `client_photo_id` resumes it without a second debit — that is the
  whole point of the reservation row (`20260908063000_bulk_photo_reservation.sql`) — so this is
  usually self-healing the next time the giver's client retries; a count that only grows is worth a
  look at whether their client is retrying at all.
- **`batches.abandoned_draft` is large** — expected at some background rate (every product has
  people who start and don't finish); a sudden jump is worth checking against whatever changed in
  the give/bulk client around that time.

**What the plan's tracked funnel asks for that this schema genuinely cannot answer today** — named
here rather than invented as a number:

- **The "first ready item" funnel step.** Readiness is computed live, never persisted with a
  timestamp — see `drafts.items_by_state.ready` above.
- **Retry rate.** `bulk_operations.attempts` increments on every successful claim, including the
  ordinary multi-invocation chunking a large batch does on purpose — it cannot tell that apart from
  a genuine failure-driven retry, and there is no separate per-item retry counter or event log.
  `drafts.items_by_state.failed` is the closest honest signal: a level (how many need a retry right
  now), not a rate.
- **Time to resume.** Nothing timestamps when a backed-off operation actually got picked back up,
  as distinct from its own routine `next_attempt_at` scheduling.

**Log hygiene.** The plan requires no raw stories, filenames, addresses or credentials in
operational logs. `src/bulk/submit.ts` and `src/cron/bulkRunner.ts` were already close: every
structured log field they write is an id (`operationId`, `itemId`, `ownerId`) or a count, and the
one place a caught exception's own `.message` reached a bare `console.error` — right next to an
already-redacted `captureException(err, ...)` call — did **not** run it through the same redaction,
which matters because this path throws from deep inside a D1 batch or a fetch while operating on a
draft item's assembled title/story/aspects, exactly the text this rule exists to keep out of
Workers Logs. Fixed by routing both call sites through a shared `redactedErrorMessage()` (exported
from `submit.ts`), which runs the caught message through the same `redactString` `capture.ts` uses.
`apps/api/test/bulkLogHygiene.test.ts` proves the wiring — not just the redaction regex — by forcing
each `console.error` line to fire with a message shaped like real leaked content (an email address,
a token-shaped credential) and asserting neither reaches the log line un-redacted; reverting the fix
locally reproduces both failures with the raw content printed verbatim next to the already-clean
`captureException` line, which is what confirmed the two really were independent before the fix.

### Minting `CF_OBSERVATORY_TOKEN`

Only Kiarash can do this — it is the one step no agent can complete, because minting an API token
is deliberately outside what any automation here is allowed to do.

In the Cloudflare dashboard, **My Profile → API Tokens → Create Token → Custom token**, scoped to
the `Leapkg@gmail.com` account (`dc6a87ed4a4269ed74c8f508b275b703`), with exactly two permissions:

| Scope   | Permission                   | Access |
| ------- | ---------------------------- | ------ |
| Account | Account Analytics            | Read   |
| Account | Workers Observability        | Read   |

Nothing else. This token is read by request-path code, so it gets the least power that does the
job: it can read counters and log lines and can change nothing. It is deliberately **not** a reuse
of `CF_CACHE_PURGE_TOKEN` (which can purge the zone) or of `CLOUDFLARE_API_TOKEN` (the CI deploy
credential, which has no business being readable from a request handler).

Then, per environment:

```bash
cd apps/api
wrangler secret put CF_OBSERVATORY_TOKEN --env production   # and --env preview
```

`CF_ACCOUNT_ID` and `CF_SCRIPT_NAME` are already set in `wrangler.toml` for both deployed tiers —
neither is a credential, so neither is a secret. With any of the three missing, the two Cloudflare
panels say `unconfigured` and name the missing piece; nothing else degrades.

Verify it took, without reading the secret back (you cannot):

```bash
curl -s "https://keepsake.ing/api/admin/observatory" -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '{edge: .edge.state, logs: .logs.state}'
# {"edge": "ok", "logs": "ok"}  — anything else, read .edge.reason / .edge.error
```

## The daily digest

`cron/dailyDigest.ts` runs at **00:07 UTC** and mails the previous UTC day to `ADMIN_DIGEST_TO`
(a Worker secret, because it is a real address and `wrangler.toml` is committed).

It sends **every day, including quiet ones**, and the subject carries the verdict — `all clear`,
`N to watch`, or `N needs attention` — so a boring day costs one glance. That is deliberate: a
digest that only sent on bad news would be silent in the one case that matters most, which is the
crons having stopped. **The absence of a digest is itself the alarm.**

With `ADMIN_DIGEST_TO` unset the report is still built every night — which proves the queries still
run — and logged instead of sent. That is a supported state, not a failure, and the cron does not
fail because of it.

**A non-failing digest keeps itself out of the stale alarm**, and that is now mechanically true
rather than a claim in a comment. `runCron` (`index.ts`) writes `cron:last:<name>` for **every**
registered job the moment the job's promise resolves, and writes nothing when it throws — so the
key means "this job finished", the heartbeat is written whether or not `ADMIN_DIGEST_TO` is set,
and a job that dies stops refreshing it.

That was not true until 2026-09-07. Each job used to write its own key as its last statement, and
`cron/dailyDigest.ts` — the last one added — wrote none, while the comments in `index.ts` and
`cron/registry.ts` already described `runCron` as the writer. A never-written key is stale by
definition, so `GET /api/admin/health` answered `ok: false` on every deployed tier permanently,
every digest listed its own cron under `needs_attention`, and the only "the crons died" channel
this system has was jammed in the alarm position — which carries exactly as much information as
one jammed in the all-clear position. Fixed by moving the write into the dispatcher, so a new cron
cannot be added without a heartbeat: the job author no longer writes one at all. History in #165.

One consequence to know rather than rediscover: the digest builds its report *before* its own
heartbeat is written, so the very first run on an environment that has never written the key still
lists `dailyDigest` as stale in that one email. It clears itself the next night.

To see today's digest without waiting for the cron, read `.report` out of the Observatory payload —
the page and the email render the same object, so they cannot disagree:

```bash
curl -s "$SITE_URL/api/admin/observatory" -H "Authorization: Bearer $ADMIN_TOKEN" | jq .report
```

**Bulk upload gets five lines in the email** (`Bulk batches active`, `Bulk items outstanding`,
`Bulk oldest operation`, `Bulk lease recoveries (active)`, `Bulk orphan bytes` — see "The
bulk-upload panel" above for what each one means) whenever `BULK_UPLOAD` is on in that environment,
so a quiet day for bulk still reports the same as a quiet day for the give flow. With the flag off
the five lines are omitted entirely, not printed as zeros — `report.bulk` is `null` in that case,
mirroring `app.bulk`'s own `{enabled: false}`. Two alerts can fire into `needs_attention` from this
data: `bulk_operation_stuck` (critical — an active operation has been queued or running past 6
hours) and `bulk_lease_recoveries` (warning — at least one operation still in flight needed its
lease recovered from an unreleased hold, the signal the runner is dying mid-run).

## Re-reading listings after a prompt change

When the vision prompt improves, existing listings keep whatever the old one said. #135 is the
worked example: the prompt learned to read the words printed on an object, and the live listing
for a fishing-line spool kept `category: other` and the single aspect `material: braided` that a
weaker prompt had produced, with no path to anything better.

`POST /api/admin/listings/:id/resuggest` is that path. What to know before running it:

- **It costs a real vision call**, metered against the same `SUGGEST_DAILY_BUDGET` ceiling the
  give flow's live autofill pays. A 429 means today's budget is spent, not that anything broke.
- **It applies nothing when the model returns nothing.** `applied: false` with a `reason` means
  the listing is untouched — a timeout must never be the thing that blanks real aspects.
- **It only ever writes `category` and `aspects`.** The title and story are the giver's, and
  `privacy.html` promises that "anything you type over it wins".
- It stamps `aspects_backfilled_at`, so a listing it has touched is no longer a backfill
  candidate.

Check the result, rather than trusting the 200 — `.data.before` and `.data.after` are both in the
response for exactly that reason.

## Verification before trusting a ban/approve action in production

Three reports from three distinct addresses should auto-hide a listing (and log a `captureMessage`
warning via Workers Logs, `src/routes/listings.ts`'s `report_autohide` handler) and surface it in
the queue under `status=hidden`; approving a held listing should move it into the public feed within
the next feed request (no cache to bust); a banned owner should get 403 on every owner-scoped
route, not just new listing creation — check `/api/me` too, not only `/api/listings`.

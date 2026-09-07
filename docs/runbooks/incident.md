# Runbook: incident

Status: current for M0; expand as M4 observability (Workers Logs, admin queue) lands.

## First, check `/health`

```sh
curl -s https://keepsake.ing/health | jq
```

`{ok, commit, env, checks}` — asserts DB/BUCKET/KV/AI/EMAIL/ASSETS bindings. `EMAIL: degraded`
is expected-and-known if Cloudflare Email Service onboarding hasn't landed yet (see
`docs/runbooks/deploy.md`); any other binding degraded or `ok: false` is a real incident.

## Common failure modes and where to look

| Symptom | Likely cause | Where |
|---|---|---|
| `/health` commit doesn't match latest `main` | deploy workflow didn't run, or the health check step itself failed and the bad deploy shipped anyway | GitHub Actions run for `deploy.yml`; re-run the deploy |
| Postcode lookups all fail/404 | `postal_codes.sql` is an unfetched LFS pointer, or the seed was never loaded for this environment | `docs/runbooks/geodata.md` — check file size first, `git lfs pull` before assuming a code bug |
| Listings stuck in `pending` | moderation budget exhausted (`MOD_TEXT_DAILY_BUDGET`/`MOD_IMAGE_DAILY_BUDGET`), or Workers AI erroring | `moderation_events` table, `reason` column; cron `moderationRetry` should clear transient errors within ~15 min (3 attempts) |
| A listing that should be held is publicly visible | moderation decide logic regression — this should never happen (fail-closed by design) | `apps/api/src/moderation/decide.ts` + its test matrix; treat as a P0, not a queue item |
| Web bundle blank/broken in production | a barrel import slipped past lint (see `docs/design/README.md#barrel-ban`), or a version-skew client is running against a moved API contract | check the deployed commit's bundle for a bare `@keepsake/*` import; check `/version.json` |
| A captured log line has an unredacted secret in it | `@keepsake/observability/redact`'s `SENSITIVE_KEY_RE` doesn't cover a new field name | extend the regex, add a test that breaks without the fix, treat any live leak as urgent regardless of severity elsewhere |

## Data loss

**[restore.md](restore.md)** — D1 Time Travel (30 days, RPO ~0, restore in about two minutes),
how to take an export that actually works on this database (`wrangler d1 export` fails outright
here because of the `listings_fts` virtual table), how to rebuild into a new database and cut
over, and how to re-seed `postal_codes` afterwards.

The one thing to know before you get there: **photo bytes in R2 are not recoverable.** No
versioning, no lifecycle rule, and `orphanSweep` deletes unconditionally. Time Travel brings back
the `photos` rows; `/i/:id/:variant` still 404s for every one of them.

## Data breach (PIPEDA) — a suspected exposure of personal data

Canada is a live market (the geo-block covers `GB`/`JE`/`GG`/`IM` only, not `CA` — see
`docs/runbooks/uk-block.md`), and PIPEDA's commercial-activity trigger has no revenue threshold or
employee-count exemption — the OPC has found free-to-user, ad-carrying sites in scope before
(*Globe24h*, PIPEDA Report of Findings #2015-002, upheld in *A.T. v. Globe24h.com*, 2017 FC 114).
Treat Keepsake as in scope. This section is what to do the moment you suspect a breach of security
safeguards involving personal data — a leaked `ADMIN_TOKEN`, a bug that exposed raw emails/phone
numbers/IPs, an R2 bucket made briefly public, a stolen or misdirected export, etc. It applies
**regardless of cause** — a bug, an attacker, or your own mistake all count.

Every citation below was fetched and read directly against the primary text — the statute itself
(`laws-lois.justice.gc.ca`, PIPEDA s.10.1) and its regulation (Canada Gazette, *Breach of Security
Safeguards Regulations*, SOR/2018-64) — not inherited from `docs/legal-open-questions-research.md`,
which flagged these two specifics as unverified when it was written.

### Step 1 — figure out what happened, in writing

Before anything else, write down (a text file, a private issue, whatever is fastest under stress):
what data, how many people, when it happened vs. when you noticed, and how you know. You will reuse
every word of this in step 3 no matter which branch you take.

### Step 2 — assess "real risk of significant harm" (PIPEDA s.10.1)

The statute names two factors, plus a catch-all:

- **(a) Sensitivity of the information involved.** A device token or `ADMIN_TOKEN` leak is high
  sensitivity — it's a bearer secret. A leaked hashed/salted value is lower. A requester's raw email
  or phone number is moderate. A listing photo of a household object is low, unless the story text
  itself contains something sensitive (health, a child's name, an address).
- **(b) Probability the information has been, is being, or will be misused.** Was it actually
  accessed by someone (server logs, an attacker's own claim), or only theoretically exposed for a
  window with no evidence anyone looked? A public S3/R2 bucket sitting open for an hour with no logged
  access is different from a `curl` transcript proving a stranger pulled every row.
- **(c) any other prescribed factor** — none have been prescribed by regulation as of this writing;
  don't invent one, and don't let its existence talk you out of (a) and (b).

The statutory bar for harm is concrete, not vibes: **"bodily harm, humiliation, damage to reputation
or relationships, loss of employment, business or professional opportunities, financial loss,
identity theft, negative effects on the credit record and damage to or loss of property."** A leaked
device token that lets someone hide or delete another person's listings, or a leaked email that lets
someone identify a giver from their public listing and show up at a "meeting point" they described,
both plausibly reach "real risk of significant harm" under this list. A leaked hashed IP with no
plausible reversal path plausibly does not — but write down why, don't just assert it.

**If in real doubt, treat it as met.** The record-keeping step below is mandatory either way, so the
only thing "met" costs you that "not met" doesn't is the report — and under-reporting is the
regulator-facing mistake, not over-reporting.

### Step 3 — if the threshold is met, report to both the OPC and affected individuals

Do both. Neither substitutes for the other. **Timing: "as soon as feasible after the organization
determines that the breach has occurred"** — PIPEDA's own words, not a fixed number of days. That
means step 1's timestamp starts the clock; don't sit on a confirmed breach while still deciding on
step 2 for a different data set from the same incident.

**Report to the Office of the Privacy Commissioner of Canada.** Per the *Breach of Security
Safeguards Regulations* (SOR/2018-64) s.2(1), the report must contain:

1. A description of the circumstances of the breach and, if known, the cause.
2. The day or period the breach occurred (or the closest approximation).
3. A description of the personal information involved, to the extent known.
4. The number of individuals affected, or the closest approximation.
5. Steps taken to reduce the risk of harm to affected individuals, or to mitigate it.
6. Steps taken or intended to notify affected individuals.
7. Name and contact information of someone who can answer the OPC's questions about the breach —
   for a one-person operation, that's Kiarash directly.

File it through the OPC's own breach-report channel: <https://www.priv.gc.ca/en/report-a-concern/report-a-breach-of-security-safeguards/> —
**unverified**: I confirmed the seven required content fields above directly against the regulation
text, but did not complete an actual submission through that page in this pass, so its current exact
form fields/format are not independently confirmed here. Re-check the page before your first real
filing rather than assuming it matches this list field-for-field.

**Notify affected individuals directly.** Per the same regulation, s.3, the notification must
contain:

1. A description of the circumstances of the breach.
2. The day or period it occurred.
3. A description of the personal information involved, to the extent known.
4. Steps you've taken to reduce the risk of harm.
5. Steps *the individual* can take to reduce or mitigate their own risk (e.g., "if you reused this
   email/password elsewhere, change it there too").
6. Contact information for the individual to ask questions.

Direct notification (email is explicitly listed as acceptable, s.4) is the default. Indirect
notification — a public posting, e.g. on the site itself — is only for when direct notification
would cause further harm, create undue hardship, or you don't have contact info for the person
(s.5); with device-token-only givers who never verified an email, indirect notification may be the
only option that exists, and that's worth stating plainly in the notice rather than pretending it
was targeted.

### Step 4 — record the breach, regardless of whether the threshold was met

**This step is not optional and does not depend on step 2's answer.** PIPEDA requires a record of
*every* breach of security safeguards, met-threshold or not. Per the regulation (SOR/2018-64 s.6),
confirmed directly against the Canada Gazette's published text:

> An organization must maintain a record of every breach of security safeguards for **24 months**
> after the day on which the organization determines that the breach has occurred.

The record must contain enough detail for the OPC to verify compliance with the reporting and
notification duties — in practice, everything from step 1 plus your step 2 reasoning (even a
"threshold not met, because..." conclusion needs to be on that record, not just an internal
judgment call that leaves no trail).

**Where the record lives for Keepsake:** a dated file under `docs/incidents/` in this repo (create
the directory on first use), named `YYYY-MM-DD-short-description.md`, containing the step 1 facts,
the step 2 assessment, and — if triggered — what was reported/notified and when. A private repo
issue is the acceptable alternative if the incident needs discussion before the facts are settled,
but the durable record belongs in the repo, not only in an issue that could be closed and forgotten.
Do not put unredacted personal data (raw emails, tokens) *into* the record itself — describe what
was exposed, don't re-expose it in the retention artifact.

**What was not independently re-verified**: the OPC's online submission form's exact current fields
(noted above), and whether any Canadian province with its own breach-notification law (several do)
imposes an additional or different duty on top of PIPEDA's — that question was out of scope for this
pass and isn't answered here. Both are candidates for `docs/legal-considerations.md`'s lawyer list if
this ever needs to be exercised for real, rather than being written into this runbook as settled.

## Alerting

`.github/workflows/uptime.yml` checks `/health` on preview (and on production once the repo
variable `PRODUCTION_LIVE` is `true`) every 15 minutes, and on failure annotates the run and
files a deduplicated `Uptime: /health failing` issue. A failed scheduled run also emails the
repository owner. That is the whole of the alerting: GitHub's scheduler is best-effort, so treat
it as "we will know within the hour", not as monitoring.

Cron failures reach Workers Logs: `scheduled` awaits each job and rethrows
(`apps/api/src/index.ts`), so a failing sweep is both a structured `captureException` log line
tagged with the cron name and a failed invocation in the Cloudflare dashboard, rather than a
detached unhandled rejection. `moderationRetry` additionally catches per listing, so one poisoned
row no longer aborts the batch. `GET /api/admin/health` returns `ok: false` when either
`cron:last:<name>` heartbeat goes stale (30 minutes for `moderationRetry`, 26 hours for
`orphanSweep`).

Unlike the Sentry setup this replaced (issue #14), none of that depends on a secret being
provisioned — Workers Logs is enabled by `[observability]` in `wrangler.toml`, not a DSN, so it's
live on every deploy with nothing left to set up. What it does **not** give you: push
notification (nobody's phone buzzes — check the dashboard or `wrangler tail`), more than 3 days of
retention on the Free plan, or issue grouping across repeated occurrences of the same error. A
Tail Worker or Logpush could add push alerting later; nothing here does that yet.

## Reports / abuse

Three independent reports auto-hide a listing (`REPORT_AUTOHIDE_THRESHOLD`) pending review in the
admin queue (`docs/runbooks/admin.md`). This is not itself an incident — it's the system working
— but a spike in auto-hides from a small number of IPs is worth a look via the `reports` table's
`ip_digest` (never a raw IP; see `docs/design/README.md` data-model notes).

**It does need a human, though, and until issue #89 nothing said so.** `GET /health` is a Worker
liveness check: an auto-hide changes a *listing's* `status`, so `/health` (and therefore
`uptime.yml`) reported `ok: true` right through the whole event. The auto-hide's
`captureMessage` writes to Workers Logs, which — see above — has no Tail Worker and no Logpush
reading it on a schedule. The admin queue knew, but only for someone who opened the admin queue.

Two things now escalate it, both keyed on the same predicate — a listing that is currently
`hidden`, has a `report_autohide` moderation event, and has no `kind = 'admin'` event at or after
it. That means **any admin action clears the alert automatically**: restore, reject or re-hide the
listing and it drops off both surfaces. Nothing to acknowledge, nothing to snooze.

1. `GET /api/admin/health` returns `report_pressure` (`autohidden_awaiting_review` and, as a
   heads-up that changes nothing, `near_threshold` — live listings one report from the same
   fate), and refuses to report `ok: true` while anything is awaiting review. The admin page's
   stats strip renders it with the same red badge a stale cron gets.
2. `.github/workflows/report-pressure.yml` runs `tools/report-pressure.mjs` hourly against each
   tier's D1 and files a deduplicated issue titled
   `Moderation: report auto-hide awaiting review (<tier>)`. It reads D1 with
   `CLOUDFLARE_API_TOKEN` rather than calling the admin endpoint because `ADMIN_TOKEN` is a
   Worker secret and no GitHub Actions secret can authenticate to an admin route — see that
   file's header. The comment carries a fingerprint of the listing ids so an open issue does not
   collect a comment every hour.

**Both directions of the risk land in the same alert on purpose.** A harmful listing that needs
confirming and a legitimate keepsake taken down by three coordinated reporters are
indistinguishable from here, and both want the same next step: a person, within hours.

To reproduce the whole chain locally without Cloudflare credentials (this is how it was verified):
apply migrations to a throwaway `--persist-to` directory, seed one `approved` listing, run
`wrangler dev --env preview --local` against that directory, `POST /api/listings/:id/reports`
three times from three different `CF-Connecting-IP` values, then
`node tools/report-pressure.mjs --env preview --local --persist-to <dir>`.

## Rate-limit / budget exhaustion

Per-IP daily budgets (`LISTING_IP_DAILY_BUDGET`, `REQUEST_IP_DAILY_BUDGET`,
`UPLOAD_IP_DAILY_BUDGET`) and the `[[ratelimits]]` per-minute bindings are burst protection, not
user-facing quotas — a real person should never hit them under normal use. If support reports a
legitimate user blocked, check which ceiling and whether it's a CGNAT/shared-IP false positive
before raising any limit.

## Escalation

There is no on-call rotation — Kiarash is the only admin (`ADMIN_TOKEN`, one secret). If the
admin token is compromised, rotate it immediately with `wrangler secret put ADMIN_TOKEN --env
production` and check `moderation_events` for any `admin`-kind events since the suspected
compromise window.

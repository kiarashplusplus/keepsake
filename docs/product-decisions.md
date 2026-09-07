# Product decisions, and what would change them

Keepsake is small enough that most of its shape is a handful of deliberate choices, each made
once, each written down somewhere different — a runbook, an issue comment, a code comment, a
closing note. That is fine for the person who made the choice and useless for anyone arriving
later, including a future session of the same agent: a decision you cannot find reads as an
accident, and an accident gets "fixed."

This file is the index. Every row names a decision, where its full reasoning lives, **what it
costs** (never "no downside" — every one of these bought something with something), and **what
would change the answer**. That last column is the point. "We got more users" or "it's only a few
lines to revert" are not triggers; a fact that invalidates the reasoning is.

**How to use it.** Before reopening any decision below, read its source document first — this page
is a summary and deliberately not the record. Before making a *new* decision that will outlive the
session, add a row. Rule 5 of [`design/README.md`](./design/README.md#agent-operating-rules)
already asks for rationale in the topic doc; this file is how the rationale gets found again.

**What does not belong here.** Bugs, tasks, and anything with an open issue that is simply
unfinished. A decision is something a reasonable person could have decided the other way, where
going back costs real work.

---

## Due for re-evaluation now

Seven, in the order a bad day would find them. Everything in the register below this section is
settled as far as anyone knows — these are the ones where the ground has actually moved since the
call was made.

### 1. The sole-proprietor decision is not finished, and is only conservative if it is

**Decided** 2026-09-07 (#108): stay a sole proprietorship, buy general-liability cover instead of
forming an LLC — on the finding that a Texas LLC would not shield a solo operator from a claim
that *he personally* screened a listing negligently, which is the claim this product actually
produces.

**The decision has two halves and only one of them happened.** The reasoning half is written down
([`legal-entity-and-insurance.md`](./legal-entity-and-insurance.md)). The paying half — bind the
cover, file the Harris County assumed-name certificate — is #142, open, `blocked-on-kiarash`.
Until then the live position is not "sole proprietorship with insurance." It is **no entity and no
cover**, on a site that is publicly arranging in-person meetings between strangers, with a renter's
policy that excludes business pursuits. The DBA half has its own edge: Business & Commerce Code
§71.201 means an unfiled assumed name cannot *maintain* an action in a Texas court on a contract
made in that name — and `terms.html` is exactly such a contract.

**Re-evaluate if** a broker declines to write this shape at all, or the quote lands well outside
the $300–800/year band the research sanity-checks against. Either would mean the insurance leg
cannot carry the weight the LLC leg was dropped for, and the entity question genuinely reopens.

### 2. Both admin tokens are committed to this repository

**Decided** 2026-09-07 (`AGENTS.md` → "Admin tokens"): write both tiers' `ADMIN_TOKEN` values into
a tracked file, because a claude.ai session holds only the repository — a credential anywhere else
is one it cannot use, and a session that cannot read the Observatory guesses instead.

**Cost, stated plainly:** there are no scopes. The same string that reads the Observatory hides
listings, bans owners, and reads a requester's note, email address and phone number. The
production one reaches real people's contact details. It is in every clone, every CI checkout and
every agent's context, and rotation is now a commit *and* a `wrangler secret put` — the old value
stays in git history either way.

**Re-evaluate the moment** this repo is made public, gains any collaborator who should not have
admin, or the tokens are pasted anywhere outside it. All three mean rotate both **first**, and
treat the history rewrite as required rather than optional. Also worth reopening if
`/api/admin/*` ever grows scopes: a read-only Observatory token would make this trade much cheaper
than it is today.

### 3. Nothing wakes anyone up, and the site is now real

**Decided** 2026-09-06 (#14): Workers Logs instead of Sentry — no third-party account to
provision, one fewer subprocessor. **Cost, accepted at the time:** 3-day retention on the Free
plan, no issue grouping, no release tracking, and **no alerting or push notification of any kind**.

What has changed since is that the site went live, and that three things now read the logs back
rather than nobody: `uptime.yml` every 15 minutes, the report-pressure workflow hourly (#89), and
the daily digest at 00:07 UTC. That is genuinely better than "nobody would ever look." It is still
"we will know within the hour," and GitHub's scheduler is best-effort.

**Re-evaluate if** an incident's diagnosis needs history older than three days, or a Saturday
outage runs long enough that the hour matters. The named follow-up is a Tail Worker or Logpush
pushing events somewhere alerting is possible; nobody has built it and no issue tracks it.

### 4. Production ships only when a human dispatches it — so production runs behind `main`

**Decided** 2026-09-07 (#13): `workflow_dispatch` only, because GitHub's required-reviewer gate is
a paid feature on private repos and "merge to `main` ships the public site" would have had nothing
standing in front of it.

**Cost:** the two tiers routinely diverge, and nothing enforces catching up. Observed at
2026-09-07 15:46 UTC — preview `454ab9a`, production `7afeb92`, five commits apart. That is the
gate working, but it also means a merged fix is not a shipped fix, and #129 was filed once already
for exactly this ("production is 7 commits behind main, including the #117 cache purge it is
documented as having"). Docs that say "we do X" while production runs code that does not is the
same failure this repo keeps catching in tests.

**Re-evaluate if** the drift causes a second incident, or if a paid GitHub plan becomes worth it —
required reviewers on `main` would let deploys follow merges without giving up the human gate. The
cheap intermediate nobody has decided on: a scheduled check that files an issue when the tiers are
more than N commits apart, which is a small extension of `uptime.yml`, which already reads both
commits.

### 5. Per-PR previews were decided, then reversed — and left a live credential behind

**Decided twice on 2026-09-07** (#73): first *for* per-PR preview Workers, which is why
`keepsake-pr-preview` was minted, scope-corrected, exercised against the live account and rolled
into `CLOUDFLARE_PR_PREVIEW_TOKEN`; then reversed to **main-only preview deploys, per-PR Workers
declined**, which is what #107 shipped. The reversal was a cost call — the CI work to provision and
tear down, not the resources, which were measured as a rounding error.

**What is left over is not a decision, it is a leftover.** A GitHub environment secret holds an
account-scoped token that can create *and delete* Workers, D1 databases, R2 buckets and KV
namespaces, and nothing uses it. That is real blast radius bought for a feature that was declined.

**Decide one of two things**, rather than leaving it: revoke `keepsake-pr-preview` and delete the
secret (and skip §5 of [`kiarash-checklist.md`](./runbooks/kiarash-checklist.md) permanently), or
build the per-PR job. Leaving a create-and-delete credential live for a feature nobody is building
is the only option that is wrong on both counts.

### 6. A listing's category comes from the model, and no human can override it

**Decided** 2026-09-07 (#35): drop the give flow's category picker; `category` follows the cover
photo's AI suggestion alone, defaulting to `"other"`. The reasoning was sound — the picker was one
more step in a flow whose product is the story, and the model usually knows better than a hurried
giver.

**What it produced:** the first real production listing showed a visitor the single word `OTHER`
(#135). Three fixes shipped — a wider category list (#136), a prompt that reads the object's own
markings (#139), and `POST /api/admin/listings/:id/resuggest` (#141) — and all three make the
*model's* answer better. **None of them adds a human path.** `UpdateListingInput` accepts
`category`, but no client ever sends one: `app/give/details.tsx` has no picker, `app/mine/[id].tsx`
edits nothing but the fields it shows, and the admin API has no set-category route — `resuggest`
re-runs the model and applies whatever comes back. If the model is wrong twice, the listing stays
wrong, and the giver — whose object it is — cannot fix it.

**Re-evaluate now**, because the premise has been tested and half-failed. The cheapest honest
version is not the old picker: it is a correction affordance on a listing that already exists
(the giver sees what the model decided and can change it), which keeps the give flow's five steps
intact and is the one path currently missing at every layer.

### 7. Photo bytes are backed up into the same account, and production may not be backed up at all

**Decided** 2026-09-07 (#17): R2 has no versioning to turn on (checked directly, not assumed), so
`tools/backup-photos.mjs` copies every referenced photo into a `<name>-backup` bucket that nothing
deletes from. Explicitly *not* solved: both buckets sit in the one Cloudflare account, so an
account-level failure takes them together. Getting bytes to a separate provider needs a credential
that does not exist.

**And the production leg has never done any work.** `backup-photos.yml` fired on schedule once and
both legs went green — but the production job's log reads `0 referenced key(s) in D1`, so it
touched no bucket and proves nothing about whether `keepsake-photos-production-backup` exists.
Production has had a listing with photos since. This is the exact shape of `AGENTS.md`'s table: a
green check mark that could not have failed.

**Do this before re-deciding anything:** read the next run's log and confirm `copied` is non-zero.
**Re-evaluate the offsite question if** production ever holds photos whose loss would actually
matter — one bucket in one account is a fine answer for a catalogue of one, and a poor one for a
catalogue of a thousand.

---

## The register

Status column: **settled** — decided, reasoning holds, nothing has changed. **watch** — decided,
with a named trigger that could plausibly fire. **due** — see the section above.

### Market and reach

| Decision | When | Costs | What would change the answer | Record |
|---|---|---|---|---|
| **Geo-block the UK** (GB + JE/GG/IM), rather than complete Online Safety Act duties | 2026-09-06, #29 | the entire UK market; seeded GB rows go inert | a lawyer finding a narrower reading of "regulated service"; or the illegal-content and children's-access assessments and complaints procedure actually being written in good faith. **Not**: traffic, a UK user asking, or "it's a few lines to revert" | [uk-block.md](./runbooks/uk-block.md), [uk-reentry-checklist.md](./runbooks/uk-reentry-checklist.md) — *settled* |
| **US + Canada only**, Canada at FSA (3-character) granularity | M1 | a CA radius is coarse — a whole forward sortation area, not a postcode | Canadian users reporting bad radius results. The fix is the normalization rule, not the schema, so this is an upgrade rather than a migration | [geo.md](./design/geo.md) — *settled* |
| **Web only**; iOS/Android a later flip on the same Expo codebase | M0 | every native-platform trap is deferred, not avoided | a native target being wanted. The traps are pre-written so the flip starts from lessons already paid for | [platform-differences.md](./platform-differences.md) — *settled* |
| **The root domain shows the feed**, not an explainer | #44 | a first-time visitor lands in a grid rather than a pitch | *settled* | #44 |

### Identity and privacy

| Decision | When | Costs | What would change the answer | Record |
|---|---|---|---|---|
| **No accounts.** A giver is a device-bound secret token plus an optional verified email | M1 | lose the device without a verified email and the listings are gone. The give flow says so explicitly | a support load of people who lost listings. Every alternative is an auth system this product does not otherwise need | [identity.md](./design/identity.md) — *settled* |
| **A requester gets no device token**, so there is no requester ban — only content removal | #70, 2026-09-07 | "ban that person's device token" is unexecutable for half the users the minor-takedown rule covers | repeat abuse from one email address. That is a change to the duplicate-request check in `listings.ts`, and minting a persistent secret for anonymous requesters purely to revoke it later would be inventing tracking for a product whose posture is minimal collection | [admin.md](./runbooks/admin.md#minors-actual-knowledge-takedown-rule) — *settled* |
| **Contact reveals only on choose**, in both directions, and cannot be recalled | M3 | a withdrawal after choosing erases Keepsake's copy and nothing else; `privacy.html` says so rather than implying otherwise | *settled* | [identity.md](./design/identity.md), [email.md](./design/email.md) |
| **Age gate is a self-declared date of birth**, never persisted — only `age_attested_at` | #64, 2026-09-07 | evidence, not verification. ICO guidance is explicit that self-declaration is not effective age assurance | UK re-entry (the ICO route then needs a written, dated "not likely to be accessed by children" rationale — not a vendor), or an actual-knowledge incident | [legal-considerations.md](./legal-considerations.md), [uk-reentry-checklist.md](./runbooks/uk-reentry-checklist.md) §6 — *watch* |
| **Admin sees a request by id, never as a browsable list of notes** | #70 | a moderator needs an id from somewhere — a report, or a giver forwarding one | moderation volume making id-lookup impractical. Streaming every stranger's note into a queue by default would be a real privacy change | [admin.md](./runbooks/admin.md) — *settled* |
| **No public postal address**, controller named instead | #26, 2026-09-06 | rests on the UK being blocked — UK GDPR Art. 13 is what wanted an address | lifting the UK block, which revives it | [legal-considerations.md](./legal-considerations.md) — *watch* |
| **Both admin tokens committed to the repo** | 2026-09-07 | see [§2](#2-both-admin-tokens-are-committed-to-this-repository) | repo goes public, or gains a collaborator | `AGENTS.md` — **due** |

### Safety and moderation

| Decision | When | Costs | What would change the answer | Record |
|---|---|---|---|---|
| **Minimal prohibited list**: auto-reject only clear illegality, hold everything borderline for one human | M1 | every borderline case costs Kiarash's attention, and there is exactly one of him | the queue outgrowing one person. The auto-hide alert (#89) is the current early warning | [moderation.md](./design/moderation.md) — *watch* |
| **Llama Guard's leniency on text about objects is accepted, not fixed** — a story describing explicit adult magazines came back `safe` | 2026-09-05, measured | text-side `review` rarely fires; the vision pass and the report button carry borderline cases | reports showing text-only abuse. Explicitly noted as the thing to watch for | [moderation.md](./design/moderation.md#real-stack-findings-preview-2026-09-05) — *watch* |
| **Request notes are screened by the contact-info regex, not the AI gate** | #19 | a note gets less scrutiny than a listing | `mod_text` headroom changing. The AI gate was declined because #18 established that budget is exhaustible by ~50 addresses, and a request is far cheaper to spam than a listing | [design/README.md](./design/README.md) — *settled* |
| **Three reports auto-hide a listing**, and any admin action clears the alert — nothing to acknowledge or snooze | #89 | three coordinated reporters can take down a legitimate keepsake | nothing yet. Both directions of the risk land in the same alert on purpose: both want a person within hours | [incident.md](./runbooks/incident.md#reports--abuse) — *settled* |
| **Fail-closed everywhere**: no AI error ever auto-approves | M1 | an AI outage parks listings in `pending` rather than publishing them | *settled* — this is the one line in moderation nobody should relax | [moderation.md](./design/moderation.md) |

### Operations

| Decision | When | Costs | What would change the answer | Record |
|---|---|---|---|---|
| **Production deploys are manual only** | #13 | production routinely runs behind `main` | see [§4](#4-production-ships-only-when-a-human-dispatches-it--so-production-runs-behind-main) | [deploy.md](./runbooks/deploy.md) — **due** |
| **Preview deploys from `main` only**; per-PR previews declined | #73 (reversed same day) | no per-branch clickthrough link; verification moved to local `e2e` | see [§5](#5-per-pr-previews-were-decided-then-reversed--and-left-a-live-credential-behind) | [deploy.md](./runbooks/deploy.md#the-per-pr-preview-token-73--provisioned-then-not-used) — **due** |
| **Workers Logs, not Sentry** | #14 | 3-day retention, no grouping, no alerting | see [§3](#3-nothing-wakes-anyone-up-and-the-site-is-now-real) | [ops.md](./design/ops.md#observability) — **due** |
| **No scheduled D1 export.** Time Travel (30 days) plus a by-hand export before anything risky | #17 | a mistake older than 30 days has no recovery at all | an export destination outside this Cloudflare account existing. An unattended weekly job writing into the same account would not survive the failure it is for, and would be one more thing that rots unnoticed | [restore.md](./runbooks/restore.md) — *settled* |
| **R2 backup lives in the same account** it insures against | #17 | an account-level failure takes both buckets | see [§7](#7-photo-bytes-are-backed-up-into-the-same-account-and-production-may-not-be-backed-up-at-all) | [restore.md](./runbooks/restore.md#r2-photo-backup) — **due** |
| **Preview is open to the internet** — `noindex` keeps it out of search, nothing keeps anyone out | undecided, #105 | anyone with the URL has the whole product, on a tier whose email is allowlisted and whose database nobody watches | this is the decision itself: #105 asks whether Cloudflare Access should gate it, and has never been answered. The launch audit raised it and the fix that shipped was the search-engine half only | #105, [launch-audit.md](./runbooks/launch-audit.md) — **due** |
| **The daily digest sends every day, including quiet ones** — the absence of the email is the alarm | #150 | one email a day that is usually boring | *settled* — a digest that only sent on bad news would be silent in the one case that matters, the crons having stopped | [admin.md](./runbooks/admin.md#the-daily-digest) |
| **Production email went live on day one**, no allowlist period | #43 | the first person to meet a delivery failure is a stranger, not a test address | *settled*, and the bet has been narrowed rather than removed: a failed send now shows on the giver's own dashboard, and `GET /api/admin/stats` groups 7 days of failures by recipient domain, so 1-of-40 and 40-of-40 stop looking alike | [kiarash-checklist.md](./runbooks/kiarash-checklist.md#day-one-posture-live-immediately-decided-2026-09-07-issue-43) |

### Product surface

| Decision | When | Costs | What would change the answer | Record |
|---|---|---|---|---|
| **Category comes from the model alone** | #35 | no human can correct it, at any layer | see [§6](#6-a-listings-category-comes-from-the-model-and-no-human-can-override-it) | #35, #135, #141 — **due** |
| **`MIN_SCORE` is a floor, not a relevance classifier** — 0.5, derived from measurement | #38, 2026-09-07 | search precision is done by ranking, not by the threshold | only a re-run of `tools/calibrate-min-score.mjs`, and only if `MODELS.embedding` changes. True-match and off-corpus distributions **overlap** (0.5693 vs 0.6151), so no cutoff separates them; raising it toward 0.62 to "improve precision" trades a graceful FTS fallback for silently dropped matches | [min-score-calibration.md](./design/min-score-calibration.md) — *settled* |
| **FTS5 stays as the fallback** behind `SEMANTIC_SEARCH`; the flag is the kill switch, not the binding | #38 | two search paths to keep working | *settled*. Do **not** roll back by re-commenting the `[[vectorize]]` bindings: a binding naming a missing index fails the Worker upload and takes every deploy with it | [deploy.md](./runbooks/deploy.md#vectorize--semantic-search-issue-38--done-on-in-every-environment) |
| **No `?w=` image transforms** — `/i/:id/:variant` serves originals | 2026-09-06 | every viewport downloads the same two sizes | a bandwidth or LCP measurement that says otherwise. The var that described this was read by no code and was deleted; add it back in the same commit that reads it | [images.md](./design/images.md) — *settled* |
| **A listing with zero aspects still surfaces** in the default feed and a broad search | #40 | shelves can't include it, and that is the intended trade | *settled* — this is eBay's aspect-filter failure mode, guarded on both sides by tests | [design/README.md](./design/README.md) |
| **v3 "Polaroids on a table"**, and ink does not flip between light and dark | 2026-09-06 | every screen's real content must sit on a `Card` or a `Print`, never bare on the table | *settled*, twice over: v1 and v2 were both rejected as generic. Do not drift back to cream-and-serif cards | [design-system.md](./design/design-system.md#v3--polaroids-on-a-table-2026-09-06) |

---

## Decisions that reversed, and what that cost

Worth its own section, because both reversals happened within hours and both left something behind.

- **#73, per-PR previews.** Decided for in the morning, against by evening. The credential minted
  in between is still live and unused ([§5](#5-per-pr-previews-were-decided-then-reversed--and-left-a-live-credential-behind)),
  and §5 of `kiarash-checklist.md` sat as a pending errand for a feature that had been declined
  until this pass corrected it. **The lesson is not "decide more slowly."** It is that a reversal
  has to walk back the artifacts the first decision created — tokens, checklists, doc sections —
  and nothing prompts anyone to do that.
- **#66 → #73, "verified on preview".** Not a reversal of intent but of a belief: preview was
  trusted as evidence for months, and was never sound while every open pull request deployed to it.
  The replacement (`pnpm --filter @keepsake/web e2e` against real `workerd`) is better than what it
  replaced, which is the good outcome; the sentence "verified on preview" survived in several docs
  after the fact, which is the bad one.

## Where a decision hides when it is not written down

Three places this pass found decisions living outside any document, listed so the next reader
knows to check them:

1. **An issue comment.** #73's reversal exists as one comment ("Resolved by #107: main-only preview
   deploys, per-PR Workers declined") plus a header comment in `deploy.yml`. Until this pass, two
   documents still described the option that lost as pending work. Comments are not searchable from
   a checkout, and a workflow header is not where anyone looks for a product decision.
2. **A closing action with no words.** #6 was closed with no comment thirteen minutes after its own
   last comment said it must stay open until someone reads an inbox. Whatever happened is not in
   the repository, and no one can now tell "tested and fine" from "closed to tidy up."
3. **A deleted issue.** #85 — whether anything indexed while preview was crawlable needs a Search
   Console removal — returns `410 This issue was deleted`. The question is now tracked in exactly
   one place: a sentence in `launch-audit.md` and this line.

The cheap habit that fixes all three: when a decision is made in a comment, add its row here in the
same session. This file is small on purpose.

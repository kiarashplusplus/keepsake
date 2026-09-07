# Keepsake design — status of record

The single place that says what state Keepsake's build is actually in. Finderly's
`docs/design/DESIGN-UX-AUDIT.md` grew to 10,400 lines and stopped being read; the fix here is
one status-of-record file plus small per-topic files, kept current in the same session code
changes, not written up after the fact.

## Where this stands — 2026-09-07

Production went live during this session, so the top of this file changes meaning: `keepsake.ing`
is a real site with real visitors possible, not a staging exercise.

**Live now**
- `https://keepsake.ing` serves `keepsake-production`. Both of that Worker's `workers.dev`
  hostnames are disabled, and so are the preview Worker's (#46, #105). Production deploys are
  still **manual** — `workflow_dispatch` — so merging to `main` does not ship the public site.
- `preview.keepsake.ing` deploys from **`main` only**; pull requests deploy nowhere (#73, which
  also resolved #66). Verify a branch with `pnpm --filter @keepsake/web e2e`, not on preview.
- Production email is `live` for all recipients (#43), and **it has still never delivered to any
  address other than Kiarash's — because it has never been asked to.** This is the single most
  important open fact in this file. #6 was closed on 2026-09-07 at 08:54 UTC with no closing
  comment, thirteen minutes after its own last comment said it must stay open until someone reads
  the `leapkg@gmail.com` inbox. This bullet hedged about which of the two had happened; **it was
  asked on 2026-09-07 and the answer is neither ambiguous nor "probably proven"**. Kiarash: *"No
  emails were sent to leapkg yet."* The Cloudflare Email Sending activity log for `keepsake.ing`
  over the preceding 7 days shows **3 sends, all three to `kiarasha@alum.mit.edu`, all delivered,
  and none to any other address**. So the second-address test was not merely unrecorded — it was
  never sent, and no amount of reading that inbox could have proven anything. **#6 is reopened**
  and still carries `launch-blocker`. What is structurally true and unchanged: `email_events.ok = 1`
  records only that the provider *accepted* the message, and there is no bounce webhook and no
  complaint feedback loop behind it — which is exactly why the provider-side log, and not our own
  success rows, is what settled this.
- `PRODUCTION_LIVE=true` is set, so `uptime.yml` genuinely probes production every 15 minutes
  rather than only checking that it *isn't* answering. That probe is also the one way an agent
  container can observe the live site at all (egress `403`s `CONNECT keepsake.ing:443`): it prints
  the commit each tier is serving, every 15 minutes, in a log anyone can read.
- **The Observatory is live on preview** (#150, PR #151): `GET /api/admin/observatory` and an
  `/admin` → Observatory panel, plus a daily digest cron at 00:07 UTC. Its D1 half — funnel, queue
  ages, per-day series — needs no credential; its Cloudflare half reads edge analytics and the
  Worker's own log lines through `CF_OBSERVATORY_TOKEN`, a read-only token scoped to exactly
  `Account Analytics Read` + `Workers Observability Read`. That secret is set on **both** tiers and
  the panels were verified returning real data on preview at `3534a94`. Production has the secret
  but not yet the code — see the tier drift below.

**Tier state — observed, not inferred, at 2026-09-07 17:03 UTC**
([uptime run 34145949309](https://github.com/kiarashplusplus/keepsake/actions/runs/34145949309)).
`uptime.yml` prints the commit each tier serves every 15 minutes, and reading that log is the only
observation of the live site an agent container can make (egress `403`s `CONNECT keepsake.ing:443`
— re-confirmed this session):

| Tier | Serving | Means |
|---|---|---|
| preview | `3980c9d` | the newest commit on `main` |
| production | `b0f5eba` | **functionally current** — see below |

**Production is no longer meaningfully behind.** A manual dispatch on 2026-09-07 took it from
`7afeb92` to `b0f5eba`, which carries semantic search (#114), the constants sweep (#143), the
raised AI budgets (#146), the labeling-milestone note (#148), **the Observatory (#151)**, **the
`resuggest` endpoint (#149)** and the zero-filled edge series (#153). The only commits it lacks are
`22e8f86` and the four from the 2026-09-07 docs sweep — all documentation, one `tools/` script and
one workflow comment, none of which the Worker runs. Do not read this gap as drift.

Production also deployed the `[[vectorize]]` bindings and did not fall over, which retires "an
uncommented binding naming a missing index fails the Worker upload" as a *deploy* risk — the three
indexes are real, at least as far as upload cares. It does not retire the rule: deleting an index
still breaks every deploy of this Worker, search-related or not.

**Two errands are now unblocked and still owed. Both need a human — an agent container cannot
reach the apex.** Run them in this order:

1. **`resuggest` the fishing-line spool** (`01M1XP7SYFDR05M1CPAH0020EE`). It shows a visitor
   `OTHER` with the single aspect `material: braided`, and the backfill will never reach it — that
   job skips any listing that already has `listing_aspects` rows. `POST
   /api/admin/listings/:id/resuggest` (#149) is the path built for exactly this, and **it is on
   production now**. Check `.data.before` / `.data.after` rather than trusting the 200.
2. **Run the aspects backfill.** `reembedListing` fires on create, on edit, and on each row the #37
   backfill touches; there is no vector-only backfill. Every production listing predates semantic
   search, so until this runs production's vector index is empty and `?q=` silently falls through
   to FTS5 — working, but not the feature that shipped. `POST /api/admin/backfill-aspects`, repeat
   until `.data.remaining` is 0. `docs/runbooks/deploy.md` → "Vectorize / semantic search" has the
   detail.

**Landed since this list was last written** (kept per rule 7 rather than deleted):
- **PR #100** (aspect backfill, #37) merged as `de75c67`; **PR #107** merged as `6412c7f`. The
  ordering constraint that entry carried was honoured — `0009_aspects_backfill.sql` kept its
  sequential name, and preflight's `migrations` rule reads the tree as "9 legacy 0001-contiguous,
  1 timestamped", so nothing was renamed under a database that had already applied it.
- **PR #139** (#135, #136) merged as `2108d37` — the prompt now reads the object's own markings
  first, `features/item/AspectList` renders aspects under the story, and the category list went
  from five to twelve. Its two deliberate leftovers touch **live production rows** and are tracked
  nowhere: the fishing-line spool keeps its single `material: braided` row, so the backfill skips
  it, and nothing re-runs a suggestion to re-categorise an existing listing off the new prompt.
- **PR #114** (semantic search, #38) merged as `97eed3e`, superseding the draft #101. It shipped
  *on*, not inert as an earlier version of this entry said — a credential arrived mid-day, the
  indexes were confirmed, the `REAL_AI=1` block ran once, and `MIN_SCORE` was re-derived to 0.5
  from a real-model run whose central finding is that true-match and off-corpus scores **overlap**,
  so ranking does the relevance work and the threshold is only a floor.
  Two things the pre-merge review caught, both of the same shape: **the #37 backfill never
  re-embedded anything** despite `reembed.ts` saying it should (it landed first, so nothing did),
  and **four comments across the branch still asserted the feature was off** after it had been
  turned on — including the runbook's reasoning that no vector backfill would ever be needed
  because production's catalogue was empty, which #135 had already disproved. Confident prose
  ages badly next to a flag; that is row six of `AGENTS.md`'s table wearing a different hat, and
  it is now the third time it has been written down on this feature.

**Open issues — re-read against GitHub on 2026-09-07, because the two lists that used to sit here
had gone stale in the direction that flatters the project.** Four of the six "blocked on a human"
issues (#6, #31, #94) and one of the two "workable by anyone" (#103) had been closed; four open
issues nothing in `docs/` mentioned at all were missing.

*Blocked on a human:*
- **#6** — **reopened 2026-09-07 evening** (it is back in this list, having been closed out of it
  that morning). Send to a second address and read that inbox; see the email bullet above for why
  the close was premature.
- **#42** — walk the app on a phone. Never done on the live apex.
- **#47** — the first real listing. [verify-production.md](../runbooks/verify-production.md) is the
  copy-pasteable form. **§1–§4 were run against the live apex on 2026-09-07 and all pass** (as did
  launch audit finding 1's re-measurement), so what is left is **§5 alone**: a keepsake posted
  through `keepsake.ing/give` from a phone and watched go `pending` → `approved`. That needs a
  person because Turnstile enforces on production, and the runbook is explicit that §1–§4 passing
  is not enough to close the issue.
- **#105** — whether Cloudflare Access should gate `preview.keepsake.ing`. Preview is open to the
  internet today; `noindex` keeps it out of search but does not keep anyone out.
- **#142** — bind general-liability cover and file the Harris County assumed-name certificate. The
  two paper halves of the #108 sole-proprietor decision, which is only the conservative choice if
  they actually happen.
- **#156** — revoke `keepsake-pr-preview` or build the job it was minted for. #73 was reversed and
  the create-and-delete token it produced is still live and used by nothing.
- **#157** — create `keepsake-photos-production-backup`. Production photos have never been backed
  up, and until 2026-09-07 the nightly job reported success anyway.
- **#158** — check whether anything was indexed while preview was crawlable (replaces the deleted
  #85).

*Workable by anyone:*
- **#104** — `wrangler dev` dies mid-e2e with no diagnostic and `serve.mjs`'s restart hides it.
- **#116** — the `adminAuth` brute-force test is flaky again on unmodified `main`. **Note the
  supersession**: `AGENTS.md` and several docs still explain this flake by pointing at #65, which
  is closed; #116's own title says #65 either regressed or was never fixed at the cause.
- **#145** — DNSSEC is disabled on the `keepsake.ing` zone.
- **#147** — an api-only pull request never runs `e2e`, because the job is scoped by
  `dorny/paths-filter` like everything else. This is the mirror image of row four of `AGENTS.md`'s
  "checks that could not fail" table.
- **#155** — a listing's category comes from the model alone and no human can correct it, at any
  layer. A product decision (#35) whose premise has been tested and half-failed.
- **#159** — decide whether a Tail Worker or Logpush is worth it. Nothing pushes an alert anywhere;
  "no" is a legitimate close, an unwritten default is not.

*Tracking issues, open by design*: #49 (launch blockers), #50 (legal & compliance), #52
(production cutover). They stay open until every child does.

**The lesson worth carrying, because it is now row six of `AGENTS.md`'s table.** Two separate
alerting/verification paths turned out never to have executed: `tools/preflight/preflight.test.mjs`
(55 tests proving each preflight check can fail — nothing ran them) and `uptime.yml`'s issue-filing
step (#106 — every `gh` call died on missing repo context). Both looked healthy because everything
*around* them worked. The common shape: **a branch that only runs when something is wrong is
evidence-free until something is wrong.** A green history says nothing about it. When you add a
path like that, force it to run once.

## Agent operating rules

Adapted from Finderly's "Agent operating rules for design work" (`DESIGN-UX-AUDIT.md:42-96`),
condensed to what actually earns its keep on a solo-agent-driven repo:

1. **Update this file (or the relevant topic file) in the same session you change the thing it
   describes.** A handoff can happen at any moment; a stale status is worse than no status.
2. **Keep scope tight.** Solve the milestone in front of you and directly related fallout. Do
   not fold in unrelated redesigns because they're nearby.
3. **Mark status honestly.** `[QA]` means "implemented, needs a human/device look" — do not mark
   `[DONE]` to make a milestone look further along than it is.
4. **Use the design system first** (`packages/tokens`, `apps/web/src/ui`). Custom one-off styling
   is a last resort, and if the pattern will recur, it belongs in the design system, not
   duplicated.
5. **Document rationale, not just outcome**, when a decision had a real tradeoff (sheet vs.
   dialog, why a token flips lightness across modes, why a check skips rather than fails).
6. **Every guard is validated by breaking it once.** A test — or a preflight check — that has
   never seen a red run has not proven anything (Finderly: the composer-keyboard formula test
   grepped source text and stayed green for the entire life of the bug it should have caught).
7. **Do not delete history.** Change a status tag or move an item to "done", but keep the record
   of what was tried and why it did or didn't work — especially for anything that took more than
   one attempt.

### Status language

- `[TODO]` — not started.
- `[IN PROGRESS]` — started, not ready for QA.
- `[QA]` — implemented, needs device/browser/human verification before it's truly done.
- `[DONE]` — implemented and verified.
- `[BLOCKED]` — cannot progress without a decision or external dependency.

## Milestones

| Milestone | Status | Summary |
|---|---|---|
| M0 Scaffold | `[DONE]` | Repo + pnpm workspaces, tokens (with contrast test), contracts `/common`, observability, api `/health` + assets serving, web `_layout`/`+html`/theme/fonts/PaperGrain/placeholder feed, preflight, `ci.yml`, `deploy.yml` to preview. |
| M1 Give + moderation | `[DONE]` | Migrations 0001–0003, geodata seed loaded on preview, owner token middleware, photo upload, create listing, moderation pipeline + cron retry + budgets, web give flow (5 steps), breathing seal, reviewing states, read-only dashboard. |
| M2 Browse + share | `[DONE]` | Feed (keyset/category/FTS/geo), item page, `/i/:id/:variant` edge cache, `/item/:id` OG injection, masonry feed, location bar, share, `+not-found`. |
| M3 Requests, email, recovery | `[DONE]` | Turnstile, requests, giver email add/verify, `sendMail()` (cf + resend fallback), choose flow + contact reveal, given/withdraw/relist/edit/delete, recovery. |
| M4 Trust and operations | `[DONE]`, version skew guard excepted (`[TODO]` on the client — issue #23) | Reports + auto-hide, admin API + page, orphan sweep, rate-limit bindings, Workers Logs observability (issue #14, replaced a never-configured Sentry), Web Analytics, Playwright in CI, runbooks. Version skew: server half (`/version.json`, `no-store`) is done and tested; nothing in `apps/web` polls it yet — see `docs/design/ops.md#version-skew`. |
| M5 Polish and launch | `[QA]` — cutover done, apex unverified | About/Privacy/Terms, empty states, motion + reduce-motion pass, keyboard/focus audit, robots/sitemap, cache-header audit, production secrets, `keepsake.ing` cutover. |

Definition of done per milestone lives with the plan (`M0`–`M5` DoD bullets); the short version:

- **M0**: preview `/health` returns `{ok, commit}`; home renders in Fraunces; dark mode persists
  with no flash; CI green; a deliberate bare `@keepsake/contracts` import fails lint and the
  guard test.
- **M1**: a 3-photo listing posts and is approved within 30 s on preview; a phone number in the
  story is rejected with the right reason; an S12-class story lands in `needs_review` invisible;
  the vision path runs once against real Workers AI; `MOD_IMAGE_DAILY_BUDGET=0` yields
  `pending/budget`; `02144`/`M5V`/`SW1A` resolve to the right places.
- **M2**: OG preview of `/item/<id>` renders in iMessage/WhatsApp; 25 mi radius from `02144`
  includes Cambridge, excludes Worcester; feed paginates without duplicates; search finds
  stemmed matches; hidden/pending items 404.
- **M3**: a request emails the giver within a minute from `hello@keepsake.ing`; choosing emails
  the requester with reply-to; recovery restores the dashboard and revokes the old token;
  Turnstile failure returns 403 with a retry.
- **M4**: three reports hide a listing and queue it; approve restores it; banned owner gets 403
  everywhere; e2e green in CI; a thrown error appears in Workers Logs with `Authorization`
  redacted.
- **M5**: Lighthouse a11y ≥ 95 on feed/item/give; production deploy from `main` with `/health`
  commit check; first real listing posted from a phone.

## Barrel ban

`packages/tokens`, `packages/contracts`, and `packages/observability` export **subpaths only** —
no `"."` entry in `package.json#exports` — so `import { x } from "@keepsake/contracts"` fails to
resolve at all, and `import { x } from "@keepsake/contracts/listing"` is the only thing that
works. `eslint.config.mjs`'s `no-restricted-imports` rule bans the bare specifiers explicitly, so
the failure is a readable lint error instead of a bundler mystery, and
`tools/preflight/preflight.mjs`'s `exports` check fails the build if any package ever grows a
`"."` key or a subpath target that doesn't exist on disk.

This exists because of a real incident: Finderly's production web bundle imported a shared
package's barrel export, which re-exported server-only code, and the SPA went blank on
production with no error a bundler surfaced early. The fix there was the same shape as here —
subpath-only exports plus a lint rule CI actually runs — except it shipped after the outage
instead of before it.

## Topic docs

- [**Product decisions**](../product-decisions.md) — the choices this build rests on, each with
  what it cost and what would change the answer. Read a row before reopening the decision it
  names; add a row when you make one.
- [Moderation](./moderation.md)
- [Identity](./identity.md)
- [Email](./email.md)
- [Feed](./feed.md)
- [Geo](./geo.md)
- [Images](./images.md)
- [Design system](./design-system.md)
- [Ops](./ops.md)

Runbooks: [deploy](../runbooks/deploy.md) · [incident](../runbooks/incident.md) ·
[admin](../runbooks/admin.md) · [geodata](../runbooks/geodata.md).

Cross-platform notes: [platform-differences.md](../platform-differences.md).

## Status notes (2026-09-06, end of day)

M0–M4 are done and verified against the live stack, not just against tests, at
<https://preview.keepsake.ing>: give → real Workers AI moderation → feed with search and
postcode radius → item page with a working link unfurl → request → choose → admin queue, plus
bans and the nightly sweep. Email sending is proven end to end (delivered, clicked, verified,
token consumed once). Turnstile is enforcing. Deploys are continuous, and the browser suite
runs on a GitHub runner (38 passing, nothing skipped).

**M5 remaining**: a keyboard and focus pass, an LCP/font-weight look, and the production
cutover (migrate + seed the production database, set its secrets, deploy, attach the apex
domain — the last step needs Kiarash).

Five things looked green today while protecting nothing: the vision prompt was copying a
pre-filled example instead of classifying, Llama Guard's self-harm category fell through
unhandled, the Metro cache shipped an empty Turnstile site key, three axe exclusions made real
contrast bugs unfailable, and the e2e job had never once executed. Each is fixed and each now
has something that fails on regression. When adding a check here, confirm it can fail.

### 2026-09-07 — six launch-audit issues closed

Landed on `claude/keepsake-github-issues-xpp03b`, off `main`, one commit per concern:

- **#19 / #21** — a request note now goes through the same contact-info regex a listing's
  title and story do (extracted from `moderation/pipeline.ts` into `moderation/contactInfo.ts`
  as a pure move), applied *before* the D1 insert rather than before the send, so an
  unmoderated note reaches neither the `requests` table nor the giver's inbox. The AI gate was
  deliberately not used: it would spend `mod_text` budget on every request, and #18 already
  establishes that budget is exhaustible by ~50 addresses. Separately, a request against a
  `given` listing now returns `410 gone` instead of the generic 404; every other non-approved
  status keeps the deliberate "not found, not forbidden" treatment.
- **#20** — listing titles reached email subject headers unescaped. Fixed at both layers:
  `TitleSchema` rejects control characters (the front door) and `sanitizeSubject()` runs at
  every `subject:` site (the backstop that matters, since a title reaches a subject from a D1
  row, not from freshly validated input). `StorySchema` untouched — the story is only ever
  interpolated into bodies that already go through `escapeHtml`, so the header vector doesn't
  exist there.
- **#16** — `GET /api/admin/health` on `main` set `ok` from `postal_codes_count` alone and
  ignored `cron_last_run`, so a month-old heartbeat sat next to `ok: true`. The endpoint fix
  was ported **byte-for-byte** from `give-flow-fixes` so it merges cleanly when #41 lands
  rather than becoming a second implementation of the same thing. An existing test that
  asserted `ok: true` with `moderationRetry` still `null` was pinned to the bug and was
  rewritten. The stats strip now carries a Crons row, ink when fresh and danger when stale.

Every one of these was proved the way this file's rule 6 asks: the guard was written, then the
production code it guards was deliberately broken, the test was watched to go red, and the
break was reverted. The specific break and its red output are recorded in each commit message
and in the closing comment on each issue.

One process note worth keeping: an early test run here reported a failure that was purely an
artifact of running the suite while an agent was still writing — the test existed before the
code did. Re-running after the work settled was clean. A red run mid-edit is not evidence of
anything.

The identity is **v3 "Polaroids on a table"** (`design-system.md`); v1 and v2 were rejected as
generic. Do not drift back toward cream-and-serif cards.

### 2026-09-07 — aspects persistence, category picker removed, neutral age gate

Three issues from the "Labeling & search" and "Legal & compliance" GitHub milestones, landed as
two PRs off `main`:

- **#36 (merged, #77)** — the suggestion endpoint's eBay-style aspects (`object`, `material`,
  `era`, …) are now persisted per listing into a new `listing_aspects` table (migration 0006) and
  returned on every listing-shaped response. #40's zero-aspect-visibility guarantee is a test now
  (`apps/api/test/aspects.test.ts`), not deferred to whenever #40 itself lands — a listing with no
  aspects still appears in the default feed and a broad FTS search.
- **#35** — the give flow's category-picker step (`app/give/details.tsx`'s `Chip` row) is gone.
  `category` now follows the cover photo's AI suggestion alone, defaulting to `"other"` if none
  ever lands (`giveDraft.ts`'s `GIVE_DRAFT_INITIAL`/`set_suggestion`). The `category` **column
  stays** on `listings` — the feed's category filter/chips, admin queue, and item page all still
  read it — this only removes the give-flow's own picker UI, per the issue's explicit instruction
  not to drop the column yet.
- **#64** — the "I'm 18 or older" checkbox (in both the give flow and the request sheet) is
  replaced by one shared `AgeGateField` (`src/features/ageGate/AgeGateField.tsx`): a neutral "what
  is your date of birth?" prompt, validated against `MINIMUM_AGE` by the identical
  `DateOfBirthSchema` client- and server-side, and never persisted — only the resulting
  `age_attested_at` timestamp is recorded, exactly as the checkbox recorded when checked. Decision
  rationale: COPPA doesn't require this for a general-audience service, but a self-selected date is
  better evidence than a checkbox that states its own passing answer for Montana's
  willful-disregard standard (#61) — the middle path the issue itself proposed.

All three verified against the real (not just mocked) UI: the full Playwright suite (70 specs,
mobile+desktop) passed against `MOCK_AI=1`, including `give.spec.ts` walking all five steps with no
category-chip click and a filled date-of-birth field, and `request.spec.ts`'s two-context
stranger/giver flow with the same field. Not verified against a live (non-mocked) Workers AI call —
neither issue touches the suggestion endpoint's own model-facing behavior.

### 2026-09-07 — Labeling & search (#51): five of six items landed, checked as a combination

The milestone's six issues merged as six separate pull requests over one day, each verified on its
own branch. Nobody had run the combination since, so this is that run — first against `main` at
`7307f06` (five items; #38 was still open in #114), then re-run after #114 merged:

| | Landed as | Where it lives on `main` |
|---|---|---|
| #35 give-flow category picker dropped | #93 | `app/give/details.tsx` has no `Chip` row; `category` column deliberately kept |
| #36 aspects persisted and indexed | #77 (`0006_aspects.sql`) | `listing_aspects` + `listing_aspects_name_value`, `apps/api/test/aspects.test.ts` |
| #37 backfill from cover photos | #100 (`0009_aspects_backfill.sql`) | `src/backfill/aspects.ts`, `aspects_backfilled_at` distinguishes "no aspects" from "never tried" |
| #39 shelves with a floor | #98 | `routes/feed.ts` `/shelves` + `shelfMinItems(env)`, `features/feed/AspectShelves.tsx` |
| #40 zero-aspect listings still surface | #98 | asserted on **both** sides: `apps/api/test/aspects.test.ts` (default feed + broad FTS) and `apps/web/test/app/index.test.tsx` (renders in the grid while a shelf it can't join is on screen) |
| #38 semantic search | #114 | `src/search/{embedding,vectorize,search,reembed}.ts` behind `SEMANTIC_SEARCH`, FTS5 kept as the fallback |

Result at `7307f06`: `pnpm lint` 0 errors · `pnpm -r typecheck` clean · API 376/376 · web 304/304 ·
`pnpm --filter @keepsake/web e2e` **82/82**, mobile and desktop · preflight all pass except
`lfs-pointers`, which is this sandbox having no `git-lfs`, not a repository fault. Re-run at
`2108d37` after #139 landed mid-check, and again on #114's merged head before merging it (API
397 passed / 3 skipped, web 316, two full CI runs green including e2e).

The three skips are the `REAL_AI=1` block and are expected: CI sets no `CLOUDFLARE_API_TOKEN`, so
that block is skipped everywhere except a run someone starts by hand with a credential. It has
been run exactly once, by the session that had one.

Two things worth carrying, neither of them a regression:

- **The milestone's plumbing was green for a day with no visible half at all.** Aspects were
  persisted, indexed, backfillable and served through `PublicListing.aspects` — and no view
  rendered one, which is how the first real production listing showed a visitor the single word
  `OTHER` (#135). #139 fixed that a few hours after this check and is now on `main`. The lesson
  outlives the fix: five green PRs closing five issues is true about the code and says nothing
  about what a visitor gets, which is why the table above records where each item lives rather
  than only that it closed.
- **Shelves (#39) have no browser-level coverage.** They are tested at the API (`shelves.test.ts`,
  including the floor and the cache TTL) and in jsdom (`test/app/index.test.tsx`), but no
  `e2e/*.spec.ts` mentions a shelf — `browse.spec.ts` predates them. The 82 green e2e specs
  therefore say nothing about a shelf rendering in a real browser.
- **The same gap, one layer down, was real rather than theoretical.** #37's backfill and #38's
  re-embedding were each green on their own branch and did not meet: the backfill wrote aspects
  and never embedded them, so the only path that reaches pre-existing listings left them out of
  vector search entirely. Nothing failed, because nothing tested the pair. Found by reading #114
  against `main` before merging it, not by a test — which is the argument for merging early that
  `docs/runbooks/issue-workflow.md` already makes, arriving a second time.

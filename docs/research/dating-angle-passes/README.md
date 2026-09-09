# Dating-angle research passes — raw subagent reports, 2026-09-09

Twenty-eight parallel web research passes, one per question, each run by a Sonnet subagent with web
search and fetch only (no repository access) and returned as a single report. **These are the
reports verbatim** — a short italic header naming the brief has been added to each, HTML entities
have been unescaped, and nothing else has been changed. No synthesis is in this folder; the
verdicts, confidence tags, "not found" lines and proposed uses are the subagent's own.

Every subagent was given the same product description (free gifting marketplace for sentimental
objects; photo + story; browse by postcode and radius with no account; "I'd love this" leaves a
note and an email; the giver chooses; no money, chat or accounts; in-person handoff; one-person
operator; Houston launch, Toronto as the Canadian test city) and asked to tag each finding
*[verified by fetch]*, *[search snippet only]* or *[could not verify]*, to give a URL and a date
for every claim, and to say "not found" rather than fill a gap.

The first ten passes were briefed on the general question — is there a dating angle to Keepsake?
The last six were briefed on the college conjunction of dating, reuse and gifting. Before those
six, the repository's only college material was one row in
[`../events-and-press-houston.md`](../events-and-press-houston.md) on Rice's "Give a Hoot! Donate
Your Loot!" spring move-out collection.

## The general question

| # | File | Brief |
|---|---|---|
| 01 | [`01-breakup-objects.md`](./01-breakup-objects.md) | Rehoming objects from an ex: demand, precedents, stunts |
| 02 | [`02-objects-as-icebreakers.md`](./02-objects-as-icebreakers.md) | Objects and their stories as an icebreaker between strangers |
| 03 | [`03-gift-economy-meet-cutes.md`](./03-gift-economy-meet-cutes.md) | People meeting partners through free-stuff and marketplace handoffs |
| 04 | [`04-post-app-shift-and-thrift-dates.md`](./04-post-app-shift-and-thrift-dates.md) | Dating-app fatigue, the shift to activity-first meeting, thrifting as a date |
| 05 | [`05-adversary-dating-framing.md`](./05-adversary-dating-framing.md) | The adversary: what goes wrong when a marketplace gets a dating angle |
| 06 | [`06-weddings-couples-objects.md`](./06-weddings-couples-objects.md) | Wedding and couple objects as supply and demand |
| 07 | [`07-gift-psychology-courtship.md`](./07-gift-psychology-courtship.md) | The psychology of sentimental gifts and giver's choice, as courtship |
| 08 | [`08-seasonal-press-hooks.md`](./08-seasonal-press-hooks.md) | Seasonal press hooks a solo operator could ride, with a Houston check |
| 09 | [`09-competitor-graveyard.md`](./09-competitor-graveyard.md) | Object- and story-based dating and connection products: live and dead |
| 10 | [`10-demand-strangers-stories.md`](./10-demand-strangers-stories.md) | Demand for browsing strangers' stories; loneliness and weak ties |

## The college conjunction

| # | File | Brief |
|---|---|---|
| 11 | [`11-campus-reuse-ecosystem.md`](./11-campus-reuse-ecosystem.md) | The US/Canada campus move-out reuse ecosystem, nationally |
| 12 | [`12-college-dating-culture-rituals.md`](./12-college-dating-culture-rituals.md) | College dating culture 2024–26 and the campus rituals that spread |
| 13 | [`13-campus-launch-playbook.md`](./13-campus-launch-playbook.md) | How campus products got their first campus; what transfers |
| 14 | [`14-houston-campuses.md`](./14-houston-campuses.md) | Rice, UH, TSU, UST, HCU, HCC one by one |
| 15 | [`15-adversary-college-framing.md`](./15-adversary-college-framing.md) | The adversary, college version: minors, marks, SCOPE Act, handoffs |
| 16 | [`16-toronto-campuses.md`](./16-toronto-campuses.md) | U of T, TMU, York, OCAD one by one; Canadian precedents and rules |

## Premise correction: "no accounts"

Every brief in this folder described Keepsake as having "no accounts." That is the repository's
architecture label ([`../../design/identity.md`](../../design/identity.md)), and on 2026-09-09 the
repository itself decided it is an architecture note, not copy; the public pages now say "no
password." The accurate model, which the subagents were not given:

- **Browsing** mints nothing; a reader is anonymous.
- **A giver** is a device-bound secret bearer token, minted on the first give and stored in the
  browser; the server keeps only its hash, in an `owners` row that also holds a **mandatory email,
  verified by a clicked link** (mandatory since 2026-09-08). Givers have a dashboard, a
  recover-by-email flow, and can be banned by the operator. There is no username, password,
  profile, or user-to-user messaging.
- **A requester** has no persistent identity: a note and an email, the email confirmed by link
  before the note reaches the giver, at most three confirmations per address per day, one request
  per email per listing. Requesters cannot be banned, only their content removed.

Passes whose reasoning leaned on the wrong premise, and how: **17** (its SCOPE Act analysis rests
on "no accounts and no profiles"; the profile prong may still hold, the account half does not);
**21** (it treats scoping as "no login" when a giver has a persistent identity and a requester an
email, both usable for rate limits and bans); **13** and **15** (their "no reliable age gate"
and "zero accounts" lines); **18** (the application answer "no screening" should read "a verified
email for every giver and every requester, no identity check"); **24** (its "new-account trust
level" pattern does apply, to the owner row). Passes 27 and 28 re-run the two most affected
questions with the accurate model. The affected files are left verbatim, with a one-line note in
their headers.

## The bottlenecks

After the first sixteen passes, ten further passes were briefed on the places where the evidence
was thin or a decision hinged on an unknown. Each file's header names the bottleneck it was sent
to resolve.

| # | File | Bottleneck |
|---|---|---|
| 17 | [`17-age-gate-scope-act.md`](./17-age-gate-scope-act.md) | No minimum age anywhere on the site; what the SCOPE Act and an age affirmation actually do for a no-account service |
| 18 | [`18-insurance-facilitated-meetups.md`](./18-insurance-facilitated-meetups.md) | Whether general-liability cover for a small marketplace responds to a handoff between strangers going wrong (#142 unbound) |
| 19 | [`19-houston-safe-exchange-zones.md`](./19-houston-safe-exchange-zones.md) | No inventory of safe-exchange locations in the Houston metro or Toronto |
| 20 | [`20-story-and-provenance-value.md`](./20-story-and-provenance-value.md) | The core assumption that a story makes an object more wanted, and what a breakup or divorce provenance does to it |
| 21 | [`21-local-scoping-without-accounts.md`](./21-local-scoping-without-accounts.md) | No precedent for scoping a campus by postcode without a login; the actual Rice–UH geography |
| 22 | [`22-rice-uh-moveout-calendar.md`](./22-rice-uh-moveout-calendar.md) | The spring 2027 dates, checkout rules and donation windows that bound a move-out ritual |
| 23 | [`23-university-marks-and-tabling.md`](./23-university-marks-and-tabling.md) | Rice and UH marks, poster, tabling and solicitation policy verbatim; the nominative-fair-use line for "near Rice" |
| 24 | [`24-moderation-load-one-person.md`](./24-moderation-load-one-person.md) | What load a two-week campus burst puts on a one-person review queue |
| 25 | [`25-houston-wedding-object-channels.md`](./25-houston-wedding-object-channels.md) | The strongest angle (wedding objects) had nothing Houston-local |
| 26 | [`26-student-email-deliverability.md`](./26-student-email-deliverability.md) | Whether confirm-then-forward email from a new domain reaches Rice and UH inboxes (#6 open) |

## Re-runs after the premise correction

| # | File | Re-runs |
|---|---|---|
| 27 | [`27-minors-laws-accurate-identity-model.md`](./27-minors-laws-accurate-identity-model.md) | Pass 17: which minors' laws reach a persistent, email-verified giver identity with no profile, and what an age affirmation does |
| 28 | [`28-abuse-controls-email-anchored-identity.md`](./28-abuse-controls-email-anchored-identity.md) | Pass 21: abuse controls and local scoping for an email-anchored giver and an email-only requester; what "no requester ban" costs |

## Reading them

- A figure tagged *[search snippet only]* was seen in a search result or a syndicated mirror and
  not read on the source page; several key pages (Forbes, Ofcom, Rice Thresher, NPR, publisher
  paywalls) refused the fetch. Re-fetch before quoting outside this repo.
- Where two passes report the same thing they were asked independently; small disagreements
  between them (Fizz on "80+" versus "240" campuses, for example) are left as found.
- Nothing here is legal advice. Passes 05 and 15 each end with a list of what a lawyer must check.

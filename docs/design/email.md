# Email

Status: `[DONE]` — M3 shipped, Cloudflare Email Service is onboarded (`hello@keepsake.ing`,
quota 1000/day, DNS configured 2026-09-06), and preview has sent real mail with
`email_events.provider=cf, ok=1`. Production runs `EMAIL_MODE=live` for all recipients (#43).
**Read "Why a provider switch exists at all" below as history, not as an open risk** — the Risk #1
it names was closed by that onboarding. What acceptance does *not* prove is delivery: there is no
bounce webhook and no complaint feedback loop, so `ok = 1` means the provider took the message
(#6, closed 2026-09-07, **reopened** the same day once it turned out the second-address test the
closure assumed had never actually been run — see `docs/design/README.md`).

Cloudflare Email Service `send_email` binding is the primary transport, sending from
`hello@keepsake.ing`; Resend is a fallback behind the same `sendMail()` interface, selected by
`EMAIL_PROVIDER` (`cf` | `resend`). `EMAIL_PROVIDER`/`EMAIL_FROM` live in `wrangler.toml [vars]`;
`RESEND_API_KEY` is a secret, never a var (enforced by `tools/preflight`'s `env-parity` check).

## Zone records: sending and inbound

Two different Cloudflare products sit on `keepsake.ing`. They use different record names, which is
why neither disturbs the other:

| Record | Purpose |
|---|---|
| `TXT cf-bounce.keepsake.ing` — `v=spf1 include:_spf.mx.cloudflare.net ~all` | SPF for the **sending** envelope |
| `TXT cf-bounce._domainkey.keepsake.ing` | the DKIM key Email Sending signs with |
| `MX cf-bounce.keepsake.ing` → `route{1,2,3}.mx.cloudflare.net` | bounce handling for sent mail |
| `MX keepsake.ing` → `route{1,2,3}.mx.cloudflare.net` | **inbound**; added 2026-09-07 |
| `TXT keepsake.ing` — `v=spf1 include:_spf.mx.cloudflare.net ~all` | added by Email Routing |
| `TXT cf2024-1._domainkey.keepsake.ing` | added by Email Routing; same public key as `cf-bounce._domainkey` |
| `TXT _dmarc.keepsake.ing` — `v=DMARC1; p=reject; rua=mailto:dmarc@keepsake.ing` | policy + reporting |

Outbound mail passes DMARC by **relaxed alignment**, not by anything at the apex: the envelope
sender is `@cf-bounce.keepsake.ing`, whose organizational domain matches the `hello@keepsake.ing`
in `EMAIL_FROM`, and DKIM signs with `d=keepsake.ing`. The apex SPF record above is Email
Routing's, and authenticates nothing we send. Don't "fix" a sending problem by editing the
`cf-bounce` records — they are the only reason mail passes today.

Sent mail carries a **second** DKIM signature, `d=cloudflare-email.net` selector `cf2024-1`. It
verifies, and it is worth nothing to DMARC: its organizational domain is not `keepsake.ing`, so it
cannot align under `adkim=r`. A receiver report showing `dkim=pass` on that signature alone would
still be a DMARC failure. Alignment rests on the `cf-bounce` SPF and DKIM records and on nothing
else — a single point of failure, confirmed as such by the first aggregate report below.

### Inbound (2026-09-07)

Until this date the apex had **no MX at all**, so every reply to `hello@keepsake.ing` bounced. That
was a real gap rather than a cosmetic one: `hello@keepsake.ing` is the `From` on all seven templates,
and `chosen` is the only one that sets reply-to elsewhere (the giver). A requester hitting reply on
any *other* message — including the request confirmation that asks them to wait to hear back — got
a bounce from the domain that had just written to them.

Email Routing is now enabled on the zone with a single **catch-all → `leapkg@gmail.com`** rule.
Two consequences worth holding onto:

- Every address at the domain is live now, including ones nobody chose, so unsolicited mail to
  `*@keepsake.ing` lands in a personal inbox. If that gets noisy, replace the catch-all with
  explicit rules for `hello@` and `dmarc@` and set the catch-all to drop — the `rua=` below needs
  `dmarc@` to stay deliverable either way.
- Email Routing marks its own records **Locked** in the dashboard, but the DNS API still reports
  `locked: null` on them. Don't read that field as proof a record is editable.

Verified so far: all records above resolve publicly (`dig @1.1.1.1`), and a production
`POST /api/admin/test-email` to `dmarc@keepsake.ing` returned `sent: true, provider: cf`. As
everywhere else in this doc, that is provider acceptance, not delivery — the catch-all is only
proven once a message is seen in the destination inbox. **That proof arrived 2026-09-09**: Google's
first aggregate report was addressed to `dmarc@keepsake.ing` and read in the destination inbox, so
the catch-all does deliver. It is the one path in this doc confirmed by receipt rather than by a
provider's acceptance.

### DMARC reporting

`rua=mailto:dmarc@keepsake.ing` was added 2026-09-07, and is same-domain on purpose. A `rua=`
pointing anywhere else (`gmail.com`, `alum.mit.edu`) needs an RFC 7489 §7.1 external-destination
record — a `keepsake.ing._report._dmarc.<that domain>` TXT on *their* zone, which we can't create —
and without it receivers silently send nothing at all. That constraint, plus the missing apex MX
that ruled out the same-domain escape, is why `p=reject` ran with no reporting until now
(issue #127); it was never a decision that reporting didn't matter.

What this buys is a trail, not an alarm. Aggregate reports are gzipped XML, arrive up to a day
late, and nothing parses them yet, so a DMARC break is still effectively invisible in real time —
which is exactly the failure mode the `EMAIL_PROVIDER` note in `wrangler.toml` warns about.

#### First report (Google, window 2026-09-08 00:00–23:59 UTC)

Received 2026-09-09. Three messages, in two rows by source IP (`104.30.8.126` ×1,
`104.30.10.153` ×2 — both Cloudflare). Every row: `header_from=keepsake.ing`, SPF pass on
`cf-bounce.keepsake.ing`, DKIM pass on `d=keepsake.ing` selector `cf-bounce`, disposition `none`.
No failures and no sources we do not recognize.

Two things this settles, both of which had been reasoning until now:

- The relaxed-alignment mechanism described above is real, as observed by a receiver rather than
  inferred from the zone. The aligned identifiers are exactly the two `cf-bounce` records; the
  `cf2024-1` signature passes and aligns with nothing.
- It measures what the `EMAIL_PROVIDER` note in `wrangler.toml` warns about. Both aligned
  identifiers are Cloudflare's, so a switch to `resend` removes both at once against `p=reject`.

What it does not settle: three messages from one receiver over one day is no evidence about
spoofing. Read an empty failure list as "nothing yet", not as "nobody is trying".

Google reports `sp=reject` and `np=reject` in `policy_published` though the TXT record sets
neither. Receivers default both to `p`; the record has not drifted.

### The one place a reply had nowhere to go

`chosen` is the only template that sets `reply-to` (to the giver), and it does so only when the
giver's address is **verified**. Until 2026-09-08 the other branch still told the requester
"Reply to this email to reach them directly" — with no `reply-to` on the message, so the reply went
to `hello@keepsake.ing` and, since the inbound catch-all above, straight into a personal inbox. The
requester was writing to Keepsake believing they were writing to the giver, and the giver never
heard about it. That branch now says the giver has their details and will be in touch, which is
what is actually true; `apps/api/test/choose.test.ts` pins both halves.

### Operational note

The account-wide Cloudflare token in `~/Documents/.env` can read and write DNS on this zone but
has **no Email Routing scope**: `GET /zones/{zone}/email/routing` and `.../email/routing/rules`
both return `10000 Authentication error` while DNS and zone-settings reads succeed. Routing rules
and destination-address verification are dashboard-only unless a token with Email Routing Rules
Edit is minted.

## Why a provider switch exists at all

Email Service account enablement and `keepsake.ing` sender-domain onboarding are **unverified**
as of the plan (Risk #1) — `[[send_email]] name = "EMAIL"` might not actually be able to send on
day one. `/health` reports `EMAIL` as `degraded` rather than failing outright if the binding
can't send, and `sendMail()` is the single call site that would need to change if `cf` never
works out.

## Send points

| Trigger | To | Notes |
|---|---|---|
| `POST /api/listings/:id/requests` | requester, always | **the only message that can be aimed at an address nobody has proved they own** (#188): one "did you ask for this?" link, carrying the listing title and nothing the submitter wrote. Capped per *recipient* address per day (`REQUEST_CONFIRM_ADDRESS_DAILY_BUDGET`), not per caller — see identity.md's "Request confirmation" |
| `POST /api/requests/confirm` | giver (if verified) | new request on their listing. Moved here from the create route by #188: until the requester redeems their link, the giver is told nothing |
| `POST /api/requests/confirm` | requester | "we passed your note along" confirmation + a signed, single-use link to `POST /api/requests/withdraw` — the requester's only no-account way back in; see `docs/design/identity.md`'s "Request withdrawal" section. Sent here rather than at submit time so the sentence is true when it is sent |
| `POST /api/me/listings/:id/choose` | requester | handoff note, reply-to set to the giver's email — this is the one place both parties' emails become mutually visible |
| `POST/POST verify` on `/api/me/email` | giver | verification link |
| `POST /api/listings` | giver | verification link — **only when the address differs from the one already on the owner row** (2026-09-08). The give flow now always sends the address it prefilled, so the old unconditional write would re-unverify and re-mail every repeat giver on every give; an unchanged-but-unverified address is left alone here so the link already in their inbox keeps working. See identity.md's "Always asked for" |
| `POST /api/recover` | the address given | recovery link, always sent as if the address matched (see identity.md) |
| `POST /api/admin/test-email` | whatever address the admin gives | on-demand delivery proof — a real send through the real path, reported back honestly (sent/blocked and why); see `docs/runbooks/admin.md` |

## Mail aimed at people who never asked for it

One send point is different in kind from every other on that table: the `confirm_request` message
goes to an address supplied by a stranger, which may belong to someone who has never heard of
Keepsake. Three rules follow, and they are load-bearing rather than stylistic — see
`src/email/templates/confirmRequest.ts`, which restates them where they can be broken:

1. **It never echoes the submitter's text.** Only the listing title is interpolated, and that is
   public, already-moderated content. Reflecting the note would make the safety mechanism a
   delivery channel for anonymous messages into a stranger's inbox.
2. **Doing nothing is a complete answer**, and the copy says so. Someone who didn't send it has
   no account to secure and nothing to click; the held row is deleted on its own.
3. **It is capped per recipient**, because confirm-then-forward alone does not stop a flood — it
   only changes what the flood is made of. M3AAWG's web-form signup recommendation
   (`draft-levine-mailbomb-header`, which proposes a `Form-Sub` header so providers can throttle
   exactly this traffic) is the industry statement of the same problem. Keepsake does not emit
   that header today — `sendMail()` exposes no per-message header hook, and neither the Cloudflare
   `EMAIL.send` shape nor the Resend call it builds carries one — which is worth knowing as an
   unclaimed improvement rather than a gap being papered over.

## Contact reveal rule

Requester contact (email, optional phone) is **masked until chosen** everywhere a giver can see
their own listing's requests (`GET /api/me/listings/:id`). Choosing a request is the one action
that flips both directions open: the response to `choose` reveals the requester's contact, and
the requester's notification email carries the giver's (via reply-to). No other code path
reveals either party's contact info.

**And it can only fire once per listing** (#185, 2026-09-07). `POST /api/me/listings/:id/choose`
used to be three separate unbatched D1 writes whose only concurrency check was a request status
read several awaits earlier, so an interrupted or concurrent choose could leave two requests
`chosen` and mail two strangers the giver's address for one object. The three writes are one
`env.DB.batch()` now — the Worker's first — opening with a conditional claim on the listing
(`... WHERE id = ? AND chosen_request_id IS NULL`) that the other two are gated on. `meta.changes`
on that claim is checked **before** `sendMail`, so a lost race answers 409 and sends nothing.

## Templates

Rendered with `@keepsake/tokens` (colors/typography) so transactional email doesn't visually
diverge from the app — warm, Fraunces-titled, not a generic transactional-email look.

## CASL: sender identification and unsubscribe

Issue #310 asked a narrower question — is a request-confirmation email a "commercial electronic
message" under CASL, given the S.6(6) transactional exemption — and it resolved to a broader
answer: it doesn't matter. S.6(6) exempts a transactional CEM from S.6(1)(a)'s *consent*
requirement only. It never touches S.6(2), which independently requires (a) identification of the
sender and (b) a mailing address valid 60+ days, plus (S.6(2)(c)/6(3)) an unsubscribe mechanism —
and every template in `src/email/templates/` is a CEM even when it's transactional. So the fix
applies to all of them, not to whichever one prompted the question.

Both requirements now live in `templates/shared.ts`'s shared footer (`renderShell` for HTML,
`footerLine()` for the several templates — `chosen`, `newRequest`, `recover`, `confirmRequest`,
`requestReceived`, `verifyEmail`, `adminTest`, `dailyDigest` — that build `text:` by hand rather
than stripping the HTML shell), rather than in each template individually, so a new template
inherits both automatically instead of restating them:

- **Identification**: "Sent by Kiarash Adl, an individual doing business as Keepsake." Keepsake
  isn't a company — `apps/site/public/terms.html` says so plainly — so identification names the
  person, not just the trade name, alongside the `hello@keepsake.ing` contact every template
  already carries elsewhere.
- **Unsubscribe**: "To unsubscribe from messages like this, email hello@keepsake.ing and say so —
  requests are honored within 10 business days." CASL accepts a stated electronic address the
  recipient can write to; it does not require a one-click mechanism. This line stays exactly as
  it was — see below for what was *added* next to it.

**What was open, and what closed it.** The first pass left two things unclosed rather than papered
over. One is still open:

1. **The mailing address (S.6(2)(b)) — still open.** `apps/site/public/privacy.html`'s "Who runs
   this" section documents not publishing one as a considered choice — Kiarash operates from a
   home address, and the analysis there is that UK GDPR Art. 13 (the one regime that would require
   it) has no UK user to attach to since the UK is geo-blocked, while PIPEDA and the relevant US
   state laws ask only for an accountable person and a way to reach them. That reasoning was never
   checked against CASL specifically, and CASL's own address clause is not obviously satisfied by
   it. This repo still does not invent, guess, or borrow an address to fill the gap — that is a
   decision for Kiarash, with counsel, not something to default into from template code.
2. **A real unsubscribe mechanism — closed, below.** What existed after the first pass was an
   electronic address to write to, which CASL accepts, but honoring it was an operational duty the
   code could not discharge by itself: nothing read that inbox, matched a request to a recipient,
   or suppressed future sends. The rest of this section is that mechanism.

### The mechanism (issue #310, part two)

**Token shape.** `src/email/unsubscribe.ts`'s `unsubscribeToken(env, address)` is an HMAC-SHA256 of
the lowercased address, keyed by the `UNSUBSCRIBE_SECRET` Worker secret, base64url-encoded the same
way every other bearer token in this Worker is. Deterministic on purpose: it needs minting nowhere
and storing nowhere until someone actually acts on it — `sendMail` derives it from the address it
already has, and the unsubscribe page needs nothing more than the token already sitting in the URL
it was handed. Not a bare `sha256Hex(address)`, and not the address itself (base64'd or otherwise):
either would put a bare or trivially-recoverable address in a URL that transits every relay and
scanner between here and the recipient's inbox — the HMAC key is what makes recovering the address
require the secret, not a dictionary of common addresses.

**Storage.** `email_suppressions` (migration `20260909223754_email_suppressions.sql`) is keyed by
`token_hash` — the SHA-256 of the token above, the same "hash what you persist" rule
`recovery_tokens.token_hash` and `requests.withdraw_token_hash` already follow. No row exists until
someone unsubscribes or resubscribes; a never-acted-on token is a lookup miss, not a pre-seeded
"subscribed" row for every address that has ever received mail.

**The footer link.** `templates/shared.ts`'s `CASL_UNSUBSCRIBE_LINK_LINE` adds a one-click line
next to the unchanged stated-address line, built around `UNSUBSCRIBE_LINK_PLACEHOLDER` — a literal
`{{unsubscribe-url}}` token, not a URL, because these template functions are pure and have no `env`
or recipient to derive a real link from. `sendMail()` (`src/email/sendMail.ts`) substitutes it for
a real per-recipient URL right before a message is actually sent: `unsubscribeWebUrl` (a page,
`/unsubscribe/:token`) in the body text, `unsubscribeApiUrl` (a POST-only API route,
`/api/unsubscribe/:token`) in the `List-Unsubscribe` header alongside RFC 8058's
`List-Unsubscribe-Post: List-Unsubscribe=One-Click` — both providers' send paths (`cf`'s
`EmailMessageBuilder.headers` and Resend's `headers` field) support arbitrary headers, so both get
this identically. When `UNSUBSCRIBE_SECRET` is unset, both URLs come back `null` and the
substitution falls back to the same `mailto:hello@keepsake.ing` address the unchanged CASL line
already names — a working, less convenient mechanism, never a dead placeholder shipped into a real
inbox.

**Why the page never mutates on GET, and the API route does on POST.** Mail clients, link
scanners, and corporate security proxies fetch URLs out of messages before a human ever sees them —
the same reasoning `requestConfirm.ts` already gives for POST-only confirmation. `GET
/api/unsubscribe/:token` is read-only status; only `POST` (from the page's own button, after it has
shown the consequence, or from a compliant mail client's one-click affordance per RFC 8058) changes
anything. Unlike `/confirm/:token` and `/withdraw/:token`, the web page does not act on mount at
all — it loads status via `GET`, states what will and will not stop arriving, and only calls `POST`
on an explicit click. That is stricter than the existing pattern for those two pages, deliberately:
this task's own brief requires the consequence to be stated *before* confirmation, not merely
relying on "a scanner probably won't run the page's JS."

**The way back.** `POST /api/resubscribe/:token` reverses `unsubscribed` on the same token, and the
same page offers it once status comes back `true`. Someone who unsubscribed and later wonders why
they never heard about their keepsake has a way to turn it back on without writing to
`hello@keepsake.ing`.

### What "unsubscribed" means here — the product question, answered

This product's outbound mail is almost entirely transactional, and the task that built this
mechanism named the trap directly: suppressing `chosen` ("you were chosen") or `confirmRequest`
("confirm your request") would defeat the very transaction the recipient started. `EmailKind`'s
`TRANSACTIONAL_EMAIL_KINDS` (`src/email/sendMail.ts`) is the decision, spelled out in full there
and summarized here:

- **Exempt from suppression — six recipient-facing kinds, plus two admin-only ones.**
  `verify_email`, `confirm_request`, and `request_received` are sent in direct, same-cycle response
  to something the recipient themselves just did (typed their address, submitted a request, was
  told it landed). `recover` is the same shape for account recovery. `chosen` is the delivery of the
  outcome of a transaction the recipient already started by requesting something — exactly the
  example the brief names. `admin_test` and `admin_digest` are addressed to the site operator, not
  a subscriber, so there is no preference to honor in the first place. None of these seven kinds
  can be suppressed by any unsubscribe link, ever, regardless of the token's state.
- **Suppressible — `new_request` alone.** Its recipient (a listing's owner) did not just take the
  action this message reports — a stranger did, by asking for something the owner posted — so it
  reads closer to "someone messaged you" than to a receipt for the recipient's own click. The
  owner's dashboard (`/mine/:id`, already linked from this exact email) shows every open request
  regardless of whether this notification ever arrives, so suppressing it costs *visibility into
  when* a new one showed up, not the request itself, and not the giver's ability to act on it. This
  is the one kind an unsubscribed address stops receiving, and it is what
  `test/emailUnsubscribe.test.ts` demonstrates end to end.
- **The default for a kind nobody has reasoned about yet is suppressible**, not exempt —
  `TRANSACTIONAL_EMAIL_KINDS` is an explicit allowlist, so a future template lands outside it unless
  someone consciously adds it. The safer default when nobody has thought it through is that an
  unsubscribed recipient stops getting the new thing, not that it silently joins the untouchable
  set.
- **The unsubscribe page states this before anyone confirms**, not after
  (`apps/web/app/unsubscribe/[token].tsx`): the confirm screen names exactly what stops (new-request
  notifications) and exactly what does not (confirmation, being chosen, recovery, verification), in
  the same sentence, before the button that acts on it.

`test/emailCaslFooter.test.ts` enumerates every template (structurally, via `import.meta.glob`,
same technique as `test/emailSubjects.test.ts`) and asserts both the stated-address line and the
one-click hook appear in *both* the HTML and the text part of each one — the text half exists
because several templates build `text:` by hand, so a footer that only reached `renderShell` would
leave text-preferring clients with neither. `test/emailPromotionalContent.test.ts` (#33) strips
exactly the (unchanged) `CASL_FOOTER_LINES` set before its promotional-language scan, since that
test's whole point is catching "unsubscribe"-shaped language drifting into a transactional email —
and here it's mandated, not drift; the set gained the one-click line but the exemption did not
widen beyond it. `test/emailUnsubscribe.test.ts` is the new mechanism's own suite: a suppressed
address gets no mail for `new_request` but still gets `chosen`; the footer's placeholder becomes a
real, distinct-per-recipient URL with working `List-Unsubscribe`/`List-Unsubscribe-Post` headers by
send time; a bare `GET` on the unsubscribe route never mutates anything; and unsubscribe/resubscribe
round-trip through the real HTTP routes into `sendMail`'s own suppression check.

## Subject headers

Template bodies are escaped throughout via `escapeHtml`; subject lines are not, because there is
no markup in a header to escape. That left the listing title interpolated raw into a header, so
`sanitizeSubject()` (`src/email/templates/shared.ts`) collapses control characters at every
`subject:` site, and `TitleSchema` rejects them on the way in.

Both layers earn their place: the schema is the front door, but a title reaches a subject from a
D1 row rather than from freshly validated input, so a row written before that check still flows
through the runtime path. If you add a template, run its subject through `sanitizeSubject`. **There are no exemptions**:
`recover.ts:33` and `verifyEmail.ts:15` wrap their static subjects too, `templates/shared.ts`
states the rule as enforced rather than advisory, and `test/emailSubjects.test.ts` enumerates the
directory and fails any `subject:` site that is unwrapped or missing the import.

## M3 status (API side)

`src/email/sendMail.ts` now does the real thing: `cf` via `env.EMAIL.send(...)` (the
`SendEmail`/`EmailMessageBuilder` shape from the generated `worker-configuration.d.ts`) or
`resend` via `POST https://api.resend.com/emails`, chosen by `emailProviderName(env)` (a
same-shape widening helper as `env.ts`'s existing `isMockAi`, since `wrangler types` gives
`EMAIL_PROVIDER` a single string-literal type). A missing binding/key, an unrecognized provider,
or the send itself throwing all fall through to a `[email:stub]` log and `{ sent: false, reason }`
— nothing here can break a give/request/choose flow. Every attempt, successful or not, is recorded
in `email_events` (migration `0004_email_events.sql`), keyed by `sha256(lowercased address)`
(`to_hash`) — never the raw address.

That last clause was true of the *key* and false of the row. `error_detail`
(`20260907083648_email_event_diagnostics.sql`) held the provider's rejection sentence verbatim,
and SMTP and Email-Routing rejections quote the destination address — so the column that exists so
we never store who was mailed sat beside a column that stored who was mailed, for the 90 days of
`orphanSweep`'s retention, surviving both the requester's withdraw link and `DELETE
/api/me/email`. The one copy that outlived a deletion request was the one nobody knew was there
(#190). A test enforced it, two lines above the assertion defending `to_hash`.

`sendMail.ts`'s `scrubProviderDetail(text, to)` now runs at the point the provider string is
captured — not on the way into D1 — so it covers all three diagnostic surfaces at once: the
`email_events` row, `POST /api/admin/test-email`, and the `console.error` line. That placement is
the point: the log line is a *direct* console call and never reaches
`@keepsake/observability/redact`. The recipient becomes `<recipient>`, then `redactString` runs as
a backstop for a *different* address the provider quotes. The sentence survives whole —
`"destination address not verified: <recipient> is not a verified destination address for this
Email Routing zone"` — because that is the half that would answer #6; only the identifier goes.
It is called *before* `truncateDetail`, so the 1000-char cut can never leave half an address
behind. Keep that order.

That fix is forward-only: it cleans every row written from then on and does nothing about the rows
already written, which are the same 90-day rows the paragraph above is about (#200). `orphanSweep`
now carries a nightly pass over them. It can only run `scrubProviderDetail`'s **second** half —
`redactString` — because the first replaces the *known* recipient and a stored row has only
`to_hash`, by design. That is enough: the local part becomes `[REDACTED]`, the domain stays (the
trade `to_domain` already makes), and the provider's sentence still reads.

Two details worth keeping if that pass is ever rewritten. It selects with
`GLOB '*[A-Za-z0-9._%+-]@*'`, not `LIKE '%@%'`: a scrubbed row still contains an `@`, so the
`LIKE` form would re-select every row it had already cleaned, every night, forever — the character
*before* the `@` is what separates `alice@gmail.com` from `[REDACTED]@gmail.com`. And it pages by
a keyset cursor over `id`, so a row the regex declines to change (an address whose domain has no
TLD, say) cannot sit at the head of the batch and starve the rows behind it. Both have tests in
`apps/api/test/orphanSweep.test.ts`, each watched to fail with the mechanism removed.

The pass is a backstop, not a substitute for scrubbing at capture: a row written unscrubbed is
still exposed until the next 03:17 UTC run. It also answers the question #200 opens with — how
many rows are affected on production, which no session can query directly — by logging
`emailDetailsScrubbed` every night and raising a `warning` through `captureMessage` on any run
that scrubs more than zero.

Seven templates in `src/email/templates/*.ts` (`verifyEmail`, `newRequest`, `requestReceived`,
`chosen`, `recover`, `adminTest`, `dailyDigest`), sharing `templates/shared.ts`'s table-based HTML shell styled
with `@keepsake/tokens/colors`'
*light* palette only (email clients don't reliably honor `prefers-color-scheme`). Each ends with
the one-line footer "Keepsake · keepsake.ing · you're getting this because …", the reason varying
per template. `chosen`'s `giverEmail` param and the `replyTo` set on the message itself always
agree (both come from the same "does the giver have a verified email" check in
`src/routes/me.ts`'s choose handler).

Wired at every send point from the table above: `POST /api/listings/:id/requests` (→ `newRequest`
to the giver, only when their email is verified, `notified_at` set on success; **and** always →
`requestReceived` to the requester, carrying the withdraw link — the giver-side send is
conditional, the requester-side confirmation is not), `POST /api/me/listings/:id/choose` (→
`chosen`, reply-to the giver when verified), `POST /api/me/email` + `POST /api/listings` with an
`email` field (→ `verifyEmail`, the same path — M1's stub link now actually resolves via
`GET /api/me/email/verify`), `POST /api/recover` (→ `recover`, only for a verified match, but
always 200 either way; the link it mails is exchanged at `POST /api/recover/exchange` with the
token in the body, sending nothing itself), `POST /api/requests/withdraw` (consumes the
`requestReceived` link's token; sends nothing itself — it's the destination, not another trigger), `POST /api/admin/test-email`
(→ `adminTest`, to whatever address the admin gives).

Tests: `apps/api/test/requests.test.ts` (notified + `email_events` row when verified, requester
confirmation sent either way, missing/false age attestation 400s), `test/requestWithdraw.test.ts`
(token consumes once, erases note/email/phone, decrements `request_count`, still works on an
already-`chosen` request), `test/choose.test.ts` (reveal + reply-to), `test/email.test.ts` (verify
single-use + expiry, `POST /api/listings` reusing the same flow, recover
new-token/old-401/unknown-still-200), `test/admin.test.ts` (test-email reports the real
sent/blocked outcome). A fake `EMAIL` binding (`test/helpers.ts`'s
`installFakeEmail`/`removeFakeEmail`) captures sends per test rather than exercising a real
provider.

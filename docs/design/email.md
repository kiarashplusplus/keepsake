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
proven once a message is seen in the destination inbox.

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

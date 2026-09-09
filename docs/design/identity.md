# Identity

Status: `[DONE]` — M1 mints the token, M3's recovery and email-verification paths are
implemented and tested (see "M3 status" below), and both were exercised end to end on preview on
2026-09-06 (link delivered, clicked, verified, token consumed once).

No accounts. A giver's identity is a device-bound secret token; a verified email exists only for
notifications and dashboard recovery — losing the device without one means losing the listings, and
the email step in `give` says so explicitly.

**The email is no longer optional** (2026-09-08). It was, and skipping it produced a listing nobody
could ever be told about: `POST /api/requests/confirm` mails a giver only when the owner row holds
a *verified* address, so every ask on an emailless listing waited on the giver happening to reopen
`/mine` on the one device holding their token, and `POST /api/recover` had nothing to mail if that
device went away. See "Always asked for" and "Staleness" below.

**"No accounts" is an architecture note, not copy** (2026-09-09). It still describes what this
product refuses to build — there is no username, no password, no profile, and no auth system — so
it stays the label on the decision in `product-decisions.md` and the first line of this file. But
`welcome.tsx`, `about.html`, `privacy.html`, `terms.html` and `llms.txt` were each selling it to a
reader who is then required to hand over an email before their listing will post, which is a
promise the product stopped keeping the day before. Those five now say "no password" — the half
that stayed true — and `apps/web/test/guards/noAccountsCopy.test.ts` fails if the shorter phrase
comes back, with a positive control on the route check so that lifting the email requirement
retires the guard instead of leaving an unexplained prohibition. Both policy pages record the
edit in their own "what changed" logs.

## Owner token

- `src/lib/ownerToken.ts`: `ks_` + base64url(32 random bytes), minted **lazily on the first give
  action** — never just for browsing, so an anonymous reader never accumulates identity.
- Storage: `src/lib/secretStore.web.ts` (localStorage) / `secretStore.native.ts`
  (`expo-secure-store` stub — web-only for now, kept compiling for the later native flip).
- Sent as `Authorization: Bearer ks_<token>`; the Worker hashes it and upserts against
  `owners.token_hash` on first write. Nothing server-side ever sees or stores the raw token.

## Always asked for

Three places enforce one invariant — *nothing goes into the feed without a way back to the person
giving it* — and they are deliberately not the same check:

- `app/give/email.tsx` (step 4 of 5) has no "Skip". It states what the address is for, and
  prefills whatever `GET /api/me` says this device's owner already has, so a returning giver
  confirms rather than retypes.
- `app/bulk/new.tsx` requires it before a batch is started, and
  `POST /api/bulk/batches/:id/submit` refuses a batch whose owner has no address — the moment a
  batch becomes live listings.
- `POST /api/listings` refuses a create where **neither the body nor the owner row** carries an
  address. Deliberately a route check rather than a required field on `CreateListingInput`: the
  invariant is about the owner row, so a giver who already gave once needs no address in the body,
  and a client from before this change is refused only in the case that is actually broken.

Asking is not verifying, and the product does not pretend otherwise: an address typed at step 4 is
unverified until its link is clicked, which is exactly what the `email_unverified` staleness reason
below is for.

One consequence worth stating, because it is easy to reintroduce: the create route now writes
`owners.email` (and mints a `verify_email` token) **only when the address differs from the one on
the row**. It used to do it for any `input.email` at all, which was harmless while the flow asked
once and let you skip — and would now drop every repeat giver back to unverified, and mail them
another link, on every single give. An unchanged-but-unverified address is left alone here too,
where `POST /api/me/email` re-sends: minting there would kill the link already in the giver's
inbox, since the redeem path refuses any token with a newer sibling (#167) and this site does not
call `invalidateOutstandingVerifyTokens`. `/mine/email`'s Resend is the button for that.

`DELETE /api/me/email` still exists and still works. Removing an address is a data right, not a
loophole to close — what it produces is a listing the dashboard flags as unreachable, which is the
next section.

## Staleness

A listing's `status` answers "what did moderation decide". It cannot answer the two questions that
actually strand people, so `GET /api/me/listings` and `GET /api/me/listings/:id` answer them
separately, as a `staleness` block on `OwnerDashboardListing`:

| Reason | When | What the giver is shown |
|---|---|---|
| `requests_unanswered` | a confirmed, still-`open` request older than `UNANSWERED_REQUEST_STALE_MS` (72 h), on a listing with no chosen request | "Someone has been waiting 5 days to hear back." |
| `email_missing` | the owner row has no address | one banner across the dashboard, with "Add an email" |
| `email_unverified` | it has one, unverified — mailed nothing but its own verification link | the same banner, with "Verify email" |

Three things about the shape, each of which was a choice:

- **The rule is one pure function**, `listingStaleness()` in `@keepsake/contracts/listing`, so the
  API that computes it and the tests that pin it cannot drift. `now` is a parameter, which is what
  makes the 72-hour boundary testable without waiting.
- **72 hours, not zero.** A fresh ask is not a neglected one, and flagging every request on
  arrival would make the flag mean "you have requests" — which `request_count` already says. The
  span deliberately matches the requester's own confirmation window: they were given three days to
  prove their address, so the giver gets three days to answer.
- **`OwnerDashboardListing` is its own schema**, not a widened `OwnerListing`. Staleness is a fact
  about a listing *and its owner's mailbox*, and the seven other routes that serialize an owner
  listing (create, edit, given/withdraw/relist, the admin queue) hold neither the email state nor
  the request rows. Widening the base schema would have had all of them answer `reasons: []` —
  "nothing wrong" where the truth is "nobody looked", which is the failure mode `AGENTS.md`'s
  eleven-row table is about. The field is required, so a dashboard route that stopped computing it
  fails the web client's parse instead of rendering a clean dashboard.

Only `pending`, `needs_review` and `approved` listings are eligible: a given, withdrawn, rejected
or hidden listing takes no new asks and needs no reachable giver.

## Recovery

- `POST /api/recover {email}` — always returns 200 regardless of whether the email matches (no
  account-enumeration signal), Turnstile-gated, emails a link to `/recover/<token>` if it does.
- `POST /api/recover/exchange {token}` — rotates `token_hash`, returns the new owner token once.
  The old token is dead the instant this succeeds: a device that loses the recovery race gets 401
  on its next request, by design (compromise containment, not a bug to smooth over). **The token
  goes in the body, never in the URL** (#182, 2026-09-07): it used to be
  `POST /api/recover/:token`, and the Worker's `onError` logged the request path verbatim, so any
  request that threw while a giver clicked their link wrote a live takeover credential into
  Workers Logs. `POST /api/requests/withdraw` already had the right shape and this now copies it.
  The emailed link is unchanged — `/recover/<token>` is the *web* app's route, and that page reads
  the token out of its own path and posts it in a body — so mail sent before the change still
  works.
- `recovery_tokens` table: `purpose` `recover` (60 min TTL — `RECOVER_TTL_MS`, raised from 30 on
  2026-09-07) or `verify_email` (24 h), single-use
  (`used_at`), plus `email` — the address a `verify_email` link was actually mailed to
  (migration `20260907181446_recovery_tokens_email.sql`).

## Request confirmation (#188)

A requester's email address is the only identity claim they ever make, and until #188 nothing
checked it. `POST /api/listings/:id/requests` accepted any syntactically valid address, wrote it
into `requests` as the requester of record, mailed it, and showed the giver a genuine-looking ask
— so anyone could enrol a third party and, if the giver chose that ask, have Keepsake deliver the
giver's real address to someone who had never asked for anything. `POST /api/recover` had already
settled the principle (it refuses to act on an unproven address); this route acted on one.

So a request is now **held, not forwarded**, until the address answers for itself:

- Submitting writes the row as `status = 'unconfirmed'` with `confirm_token_hash` and
  `confirm_expires_at` (72 h), and mails exactly one message — the `confirmRequest` "was this
  you?" link. It carries the listing title and *nothing the submitter wrote*: reflecting a
  stranger's free text into a stranger's inbox would rebuild the harassment channel the step
  exists to close.
- `POST /api/requests/confirm` redeems that token. It is the only place the giver's side moves:
  the row becomes `open`, `request_count` is incremented, the giver is mailed, and the withdraw
  token below is minted. A POST from `/confirm/<token>` in the web app rather than a GET on the
  emailed URL, because mail scanners and security proxies fetch links before a human sees them —
  a confirmation that completed on GET would be completed by the victim's own provider.
- Nothing confirmed is deleted, not redacted, by the nightly sweep once the link lapses. An
  address nobody vouched for is data this service was never authorised to hold.
- Every owner-facing read filters on `confirmed_at IS NOT NULL`, including the choose lookup —
  the one action that mails a stranger the giver's address.

The confirmation step stops a victim being *enrolled*; on its own it does not stop them being
*mailed*, and one message per listing across a public feed is a mail-bomb whichever gate it passes
(the failure mode M3AAWG's web-form recommendation names, where the confirmation is itself the
payload). So a second control sits beside it: `REQUEST_CONFIRM_ADDRESS_DAILY_BUDGET`, a ceiling
keyed by the **recipient's** address rather than the caller's IP — the only shape of limit an
attacker cannot widen by moving. Being over it looks exactly like succeeding, and writes nothing.

## Request withdrawal

A requester never gets a device token or a dashboard — the only record they have of having asked
for a keepsake is the `requestReceived` confirmation email (`src/email/templates/requestReceived.ts`),
sent from `POST /api/requests/confirm` once the address above is proved (before #188 it went out
at submit time, when nothing had in fact been passed along to anyone). That email carries a signed, single-use
link (the same `randomTokenRaw()` + sha256-of-the-raw-value shape every other bearer secret here
uses) to `POST /api/requests/withdraw`, which erases that request's `note`/`email`/`phone` and
flips its status to `withdrawn` — no login, no proof of identity beyond possessing the link, by
design: the link *is* the identity claim, same as a recovery link is for an owner.

A request that was already `chosen` can still be withdrawn. Its contact info may already have been
revealed to the giver and mailed to them (see `docs/design/email.md`'s "contact reveal rule") —
that disclosure can't be recalled, and `apps/site/public/privacy.html` says so plainly rather than
implying withdrawal un-sends anything. Withdrawing at that point only erases Keepsake's own stored
copy and updates what the owner's dashboard shows going forward.

`listings.request_count` is decremented on withdrawal (floored at 0) so it keeps meaning "how many
live asks does this listing have," not "how many were ever made." Since #188 it is *incremented*
at confirmation rather than submission, for the same reason — which is why the admin removal path
decrements only for a request that was confirmed, and an unconfirmed one takes nothing with it.

## Admin

Separate identity plane entirely: `Bearer <ADMIN_TOKEN>`, one secret, constant-time compared,
Kiarash alone. Not an owner token with elevated scope — there is no user table row for the admin.

## Why this shape

- Device-bound-by-default avoids building accounts (auth, password reset, sessions) for a product
  with no signed-up users and no money changing hands.
- The email is optional and separable from identity: adding, changing, or removing it
  (`POST/DELETE /api/me/email`) never touches the owner token itself.
- Every write path re-derives identity from the bearer token per request — there is no session
  state to leak or expire mid-flow.

## M3 status (API side)

`POST /api/recover` and `POST /api/recover/exchange` (`apps/api/src/routes/recover.ts`) implement
recovery exactly as described above: always `{ sent: true }` regardless of a match (no
enumeration signal — the D1 lookup and the conditional send happen entirely inside the "always
200" branch); a matching, *verified* owner gets a 60-minute `recovery_tokens` row (`purpose =
'recover'`) and the `recover` email template; exchanging the token rotates `owners.token_hash` and
marks the row used in the same request, so the old token 401s on its very next call and the
recovery token itself can't be replayed. `POST /api/me/email` mints the `verify_email` counterpart
(24 h TTL) and `GET /api/me/email/verify` redirects to `/mine?verified=1|0&reason=expired|invalid`.

**A verify link is bound to the address it was mailed to, not to the owner row** (#167,
2026-09-07). It used to be bound only to `owner_id`, so redeeming any unexpired link stamped
"verified" on whatever address sat on the row at click time — reachable by typing an address,
correcting it, and then clicking the first link out of your inbox, with no attacker involved.
Since verification is what gates recovery mail, request notifications, and revealing the giver's
address to a chosen requester, that attached all three to an address nobody had confirmed. Two
conditions now both have to hold at redeem time: the address recorded on the token still matches
`owners.email`, and no newer `verify_email` token exists for that owner. The second is what fails
a token minted before the column existed — or by `POST /api/listings`, which does not record one —
closed rather than open. `POST /api/me/email` and `DELETE /api/me/email` also mark outstanding
`verify_email` tokens used the moment they change or clear the address, so nothing redeemable is
left in the table; `recover` tokens are deliberately untouched by that, since editing an address
must not kill a live recovery link for someone who has already lost their device.

Both token kinds share `src/lib/tokens.ts`'s `randomTokenRaw()` — one `crypto.getRandomValues(32)`
+ base64url-without-padding implementation for every raw secret this Worker mints (owner tokens,
verify links, recovery links), replacing the M1 stub's ad hoc `crypto.randomUUID() +
crypto.randomUUID()` string in `POST /api/listings`'s email path.

Tests: `apps/api/test/email.test.ts` covers verify (single-use, expiry) and recover (fresh token
works, old owner token 401s immediately after, an unknown email still returns `{ sent: true }`,
the recovery token itself is single-use).

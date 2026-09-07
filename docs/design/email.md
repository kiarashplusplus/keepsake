# Email

Status: `[DONE]` — M3 shipped, Cloudflare Email Service is onboarded (`hello@keepsake.ing`,
quota 1000/day, DNS configured 2026-09-06), and preview has sent real mail with
`email_events.provider=cf, ok=1`. Production runs `EMAIL_MODE=live` for all recipients (#43).
**Read "Why a provider switch exists at all" below as history, not as an open risk** — the Risk #1
it names was closed by that onboarding. What acceptance does *not* prove is delivery: there is no
bounce webhook and no complaint feedback loop, so `ok = 1` means the provider took the message
(#6, closed 2026-09-07).

Cloudflare Email Service `send_email` binding is the primary transport, sending from
`hello@keepsake.ing`; Resend is a fallback behind the same `sendMail()` interface, selected by
`EMAIL_PROVIDER` (`cf` | `resend`). `EMAIL_PROVIDER`/`EMAIL_FROM` live in `wrangler.toml [vars]`;
`RESEND_API_KEY` is a secret, never a var (enforced by `tools/preflight`'s `env-parity` check).

## Why a provider switch exists at all

Email Service account enablement and `keepsake.ing` sender-domain onboarding are **unverified**
as of the plan (Risk #1) — `[[send_email]] name = "EMAIL"` might not actually be able to send on
day one. `/health` reports `EMAIL` as `degraded` rather than failing outright if the binding
can't send, and `sendMail()` is the single call site that would need to change if `cf` never
works out.

## Send points

| Trigger | To | Notes |
|---|---|---|
| `POST /api/listings/:id/requests` | giver (if verified) | new request on their listing |
| `POST /api/listings/:id/requests` | requester, always | "we passed your note along" confirmation + a signed, single-use link to `POST /api/requests/withdraw` — the requester's only no-account way back in; see `docs/design/identity.md`'s "Request withdrawal" section |
| `POST /api/me/listings/:id/choose` | requester | handoff note, reply-to set to the giver's email — this is the one place both parties' emails become mutually visible |
| `POST/POST verify` on `/api/me/email` | giver | verification link |
| `POST /api/recover` | the address given | recovery link, always sent as if the address matched (see identity.md) |
| `POST /api/admin/test-email` | whatever address the admin gives | on-demand delivery proof — a real send through the real path, reported back honestly (sent/blocked and why); see `docs/runbooks/admin.md` |

## Contact reveal rule

Requester contact (email, optional phone) is **masked until chosen** everywhere a giver can see
their own listing's requests (`GET /api/me/listings/:id`). Choosing a request is the one action
that flips both directions open: the response to `choose` reveals the requester's contact, and
the requester's notification email carries the giver's (via reply-to). No other code path
reveals either party's contact info.

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
through the runtime path. If you add a template, run its subject through `sanitizeSubject` —
`recover.ts` and `verifyEmail.ts` are exempt only because their subjects are static.

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

Six templates in `src/email/templates/*.ts` (`verifyEmail`, `newRequest`, `requestReceived`,
`chosen`, `recover`, `adminTest`), sharing `templates/shared.ts`'s table-based HTML shell styled
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
always 200 either way), `POST /api/requests/withdraw` (consumes the `requestReceived` link's token;
sends nothing itself — it's the destination, not another trigger), `POST /api/admin/test-email`
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

# Email

Status: `[QA]` (M3 API side implemented; a real send from `hello@keepsake.ing` on preview per M3 DoD is still owed — see plan Risk #1).

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
| `POST /api/me/listings/:id/choose` | requester | handoff note, reply-to set to the giver's email — this is the one place both parties' emails become mutually visible |
| `POST/POST verify` on `/api/me/email` | giver | verification link |
| `POST /api/recover` | the address given | recovery link, always sent as if the address matched (see identity.md) |

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

Four templates in `src/email/templates/*.ts` (`verifyEmail`, `newRequest`, `chosen`, `recover`),
sharing `templates/shared.ts`'s table-based HTML shell styled with `@keepsake/tokens/colors`'
*light* palette only (email clients don't reliably honor `prefers-color-scheme`). Each ends with
the one-line footer "Keepsake · keepsake.ing · you're getting this because …", the reason varying
per template. `chosen`'s `giverEmail` param and the `replyTo` set on the message itself always
agree (both come from the same "does the giver have a verified email" check in
`src/routes/me.ts`'s choose handler).

Wired at every send point from the table above: `POST /api/listings/:id/requests` (→ `newRequest`,
only when the giver's email is verified, `notified_at` set on success), `POST
/api/me/listings/:id/choose` (→ `chosen`, reply-to the giver when verified), `POST /api/me/email`
+ `POST /api/listings` with an `email` field (→ `verifyEmail`, the same path — M1's stub link now
actually resolves via `GET /api/me/email/verify`), `POST /api/recover` (→ `recover`, only for a
verified match, but always 200 either way).

Tests: `apps/api/test/requests.test.ts` (notified + `email_events` row when verified, no send when
unverified), `test/choose.test.ts` (reveal + reply-to), `test/email.test.ts` (verify single-use +
expiry, `POST /api/listings` reusing the same flow, recover new-token/old-401/unknown-still-200).
A fake `EMAIL` binding (`test/helpers.ts`'s `installFakeEmail`/`removeFakeEmail`) captures sends
per test rather than exercising a real provider.

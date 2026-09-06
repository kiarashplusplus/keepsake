# Identity

Status: `[TODO]` (M1 mints the token; M3 adds recovery).

No accounts. A giver's identity is a device-bound secret token; an optional verified email exists
only for notifications and dashboard recovery — losing the device without one means losing the
listings, and the email step in `give` says so explicitly.

## Owner token

- `src/lib/ownerToken.ts`: `ks_` + base64url(32 random bytes), minted **lazily on the first give
  action** — never just for browsing, so an anonymous reader never accumulates identity.
- Storage: `src/lib/secretStore.web.ts` (localStorage) / `secretStore.native.ts`
  (`expo-secure-store` stub — web-only for now, kept compiling for the later native flip).
- Sent as `Authorization: Bearer ks_<token>`; the Worker hashes it and upserts against
  `owners.token_hash` on first write. Nothing server-side ever sees or stores the raw token.

## Recovery

- `POST /api/recover {email}` — always returns 200 regardless of whether the email matches (no
  account-enumeration signal), Turnstile-gated, emails a link to `/recover/<token>` if it does.
- `POST /api/recover/:token` — rotates `token_hash`, returns the new owner token once. The old
  token is dead the instant this succeeds: a device that loses the recovery race gets 401 on its
  next request, by design (compromise containment, not a bug to smooth over).
- `recovery_tokens` table: `purpose` `recover` (30 min TTL) or `verify_email` (24 h), single-use
  (`used_at`).

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

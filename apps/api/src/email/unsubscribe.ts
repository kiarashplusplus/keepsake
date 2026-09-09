/**
 * The real one-click unsubscribe mechanism issue #310's first pass left
 * open. `templates/shared.ts`'s footer used to promise only "email
 * hello@keepsake.ing and say so" — nothing read that inbox, matched a
 * request to a recipient, or suppressed anything. This is what does.
 *
 * **Token shape.** A per-recipient token is an HMAC-SHA256 of the lowercased
 * address, keyed by `UNSUBSCRIBE_SECRET` (`hmacSha256`, `../lib/digest.ts`)
 * — deterministic, so it needs minting nowhere: `sendMail` derives it from
 * the address it already has at send time, and the unsubscribe page derives
 * nothing at all, because the link it was handed already *is* the token.
 * Deliberately not a bare `sha256Hex(address)` the way `email_events.to_hash`
 * is: that column never leaves the database, but this token is mailed to the
 * recipient and read by every relay and scanner between here and their
 * inbox, so recovering the address behind it must require the secret, not
 * just a dictionary of common addresses. And deliberately not the address
 * itself, base64'd or otherwise — that would still be a bare address one
 * decode away, which is exactly what "do not put a bare email address in a
 * URL" rules out.
 *
 * **Storage.** `email_suppressions` is keyed by `token_hash` — the SHA-256 of
 * the token above, the same "hash what you persist" rule every other
 * single-use link in this Worker follows (`recovery_tokens.token_hash`,
 * `requests.withdraw_token_hash`). A row exists only once someone has acted
 * on a link; checking a never-unsubscribed address is a lookup miss, not a
 * pre-seeded "false" row for every address that has ever received mail.
 *
 * **The secret is set-once, not rotated.** The token being a deterministic
 * function of the address is what lets `sendMail` derive it at send time
 * with nothing stored — but it also means the secret is load-bearing for
 * every suppression already on file. Rotate it and the same address hashes
 * to a new token, which misses its old `email_suppressions` row: every
 * unsubscribe link already in an inbox stops validating, and everyone who
 * had unsubscribed starts receiving `new_request` mail again. That is a
 * CASL regression, not a broken link. Migrating the rows alongside a
 * rotation would need the old secret *plus* the suppressed addresses, and
 * this system keeps neither in recoverable form by design — the table holds
 * `token_hash` only, and `email_events` holds `to_hash`, itself one-way. So
 * a rotation is a breaking change that needs a plan before it, not a
 * scheduled hygiene task; `docs/runbooks/deploy.md#secrets` says so where
 * someone would actually reach for `wrangler secret put`.
 *
 * **Missing secret fails open, not closed.** `UNSUBSCRIBE_SECRET` is a
 * `wrangler secret`, unset in this repo the same way `TURNSTILE_SECRET` and
 * `RESEND_API_KEY` are (`.dev.vars.example`). If it is ever unset in a real
 * environment, `unsubscribeToken` returns `null` and every function below
 * degrades rather than throwing: `isUnsubscribed` reports "not suppressed"
 * (a misconfigured secondary system must never block a primary send), and
 * the link-building helpers report `null` so `sendMail` falls back to the
 * plain `mailto:` address already named in the footer's CASL line — the
 * mechanism this replaces, not a broken link.
 */
import type { Env } from "../env.js";
import { hmacSha256, sha256Hex } from "../lib/digest.js";

/** `undefined` when unset or blank — never an empty-string secret, which
 * would make every address hash to the same token. */
function unsubscribeSecret(env: Env): string | undefined {
  const secret = (env.UNSUBSCRIBE_SECRET ?? "").trim();
  return secret.length > 0 ? secret : undefined;
}

/** The token embedded in both the footer link and the `List-Unsubscribe`
 * header — see the module doc comment for why it's an HMAC and not a bare
 * hash. `null` only when `UNSUBSCRIBE_SECRET` isn't configured. */
export async function unsubscribeToken(env: Env, address: string): Promise<string | null> {
  const secret = unsubscribeSecret(env);
  if (!secret) return null;
  return hmacSha256(secret, address.trim().toLowerCase());
}

/** The human-facing link: a web page (`apps/web/app/unsubscribe/[token].tsx`)
 * that states the consequence and asks for an explicit click before it
 * POSTs anywhere — never the API route directly, so a mail client or
 * scanner that merely fetches this URL (a GET) renders inert markup, not a
 * mutation. */
export async function unsubscribeWebUrl(env: Env, address: string): Promise<string | null> {
  const token = await unsubscribeToken(env, address);
  return token ? `${env.SITE_URL}/unsubscribe/${token}` : null;
}

/** The RFC 8058 one-click target: a POST-only API route a compliant mail
 * client hits directly, with no page in between, in response to the
 * recipient using *its own* "Unsubscribe" affordance — that in-client
 * affordance is the human confirmation RFC 8058 relies on instead of a
 * landing page, which is why this URL is allowed to act immediately on POST
 * where the web page above never does on GET. */
export async function unsubscribeApiUrl(env: Env, address: string): Promise<string | null> {
  const token = await unsubscribeToken(env, address);
  return token ? `${env.SITE_URL}/api/unsubscribe/${token}` : null;
}

interface SuppressionRow {
  suppressed: number;
}

/** Whether `address` has an active, unrevoked unsubscribe on file. Consulted
 * by `sendMail` before every send whose kind isn't in
 * `TRANSACTIONAL_EMAIL_KINDS`. Fails open (see module doc comment) when the
 * secret is unset — a send that cannot be checked is not thereby suppressed. */
export async function isUnsubscribed(env: Env, address: string): Promise<boolean> {
  const token = await unsubscribeToken(env, address);
  if (!token) return false;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare("SELECT suppressed FROM email_suppressions WHERE token_hash = ?")
    .bind(tokenHash)
    .first<SuppressionRow>();
  return row?.suppressed === 1;
}

export interface SuppressionStatus {
  /** `false` for a token nobody has ever acted on — not an error, since the
   * whole point is that no row needs to exist until someone does. */
  unsubscribed: boolean;
}

/** Read-only status for a raw token straight from a URL — the GET half of
 * `routes/unsubscribe.ts`, which the web page calls on mount to decide what
 * to show. Must never mutate: a link scanner or corporate proxy prefetching
 * this exact URL is the scenario `GET /api/unsubscribe/:token` exists to be
 * safe against. */
export async function suppressionStatusForToken(env: Env, token: string): Promise<SuppressionStatus> {
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare("SELECT suppressed FROM email_suppressions WHERE token_hash = ?")
    .bind(tokenHash)
    .first<SuppressionRow>();
  return { unsubscribed: row?.suppressed === 1 };
}

/**
 * Sets suppression state for a raw token — the POST half, shared by
 * `POST /api/unsubscribe/:token` (`suppressed: true`) and
 * `POST /api/resubscribe/:token` (`suppressed: false`). An upsert, not an
 * insert-then-update: the first time either route is hit for a given token
 * there is no row yet, and `ON CONFLICT` is what makes "unsubscribe, then
 * resubscribe, then unsubscribe again" keep working without a separate
 * existence check.
 *
 * Idempotent by construction — clicking an already-fired one-click link a
 * second time (a client retry, a second scanner) just rewrites the same
 * `suppressed` value with a newer timestamp, never errors.
 */
export async function setSuppression(env: Env, token: string, suppressed: boolean): Promise<void> {
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO email_suppressions (token_hash, suppressed, unsubscribed_at, resubscribed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(token_hash) DO UPDATE SET
       suppressed = excluded.suppressed,
       unsubscribed_at = CASE WHEN excluded.suppressed = 1 THEN excluded.unsubscribed_at ELSE email_suppressions.unsubscribed_at END,
       resubscribed_at = CASE WHEN excluded.suppressed = 0 THEN excluded.resubscribed_at ELSE email_suppressions.resubscribed_at END,
       updated_at = excluded.updated_at`,
  )
    .bind(tokenHash, suppressed ? 1 : 0, suppressed ? now : null, suppressed ? null : now, now, now)
    .run();
}

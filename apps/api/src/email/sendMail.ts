/**
 * `sendMail(env, message)` — the one call site every notification email goes
 * through (verify, new request, request received, chosen, recover, admin
 * test). Two providers behind the same interface, selected by
 * `EMAIL_PROVIDER`:
 *
 *  - `cf`: `env.EMAIL.send(...)` (the `[[send_email]]` binding).
 *  - `resend`: `POST https://api.resend.com/emails` with `RESEND_API_KEY`.
 *
 * Cloudflare Email Service account enablement and the `keepsake.ing` sender
 * onboarding are unverified (plan Risk #1) — a missing binding/key, an
 * unrecognized provider value, or the send itself throwing all fall through
 * to a `[email:stub]` log rather than throwing. A give/request/choose flow
 * must never break because notification email isn't wired up yet; the
 * caller gets `{ sent: false, reason }` back to act on if it cares (nothing
 * currently does — every call site fires-and-forgets this).
 *
 * Every attempt, successful or not, is recorded in `email_events`
 * (`0004_email_events.sql`) keyed by `sha256(lowercased address)` — never
 * the raw address — so "did this actually send" is answerable from the DB.
 * `20260907083648_email_event_diagnostics.sql` adds the two columns that make a
 * *failure* answerable too: `error_detail` (the provider's own words, kept
 * whole and kept apart from the stable `error` code) and `to_domain` (the
 * recipient's provider, not the recipient), which together are what separate
 * "one address bounced" from "this binding refuses every unverified
 * destination" — issue #6's worst case, and until now indistinguishable from
 * working.
 *
 * `error_detail` used to hold the provider's sentence *verbatim*, and SMTP
 * and Email-Routing rejections quote the destination address — so the column
 * that exists so we never store who was mailed sat beside a column that
 * stored who was mailed, and that row outlived both the requester's withdraw
 * link and `DELETE /api/me/email`. `scrubProviderDetail` (below) is the fix
 * for #190: every provider string is scrubbed at the point it is captured,
 * which is also the only way to cover the `console.error` lines, since those
 * are direct console calls that never reach `redactString`.
 */
import { isReservedEmailDomain } from "@keepsake/contracts/common";
import { redactString } from "@keepsake/observability/redact";
import type { Env } from "../env.js";
import { emailProviderName } from "../env.js";
import { sha256Hex } from "../lib/digest.js";
import { ulid } from "../lib/ids.js";
import { isUnsubscribed, unsubscribeApiUrl, unsubscribeWebUrl } from "./unsubscribe.js";
import { UNSUBSCRIBE_LINK_PLACEHOLDER } from "./templates/shared.js";

/**
 * Recipient guard — the reason Keepsake cannot spray bounces at its own
 * sending reputation.
 *
 * Cloudflare scores a sending domain on bounce rate (safe under 2%, at risk
 * at 5%). At our volume that is one or two bad addresses, and the repo is
 * full of `someone@example.com` fixtures: 80 of them across the API, web and
 * contract tests. Those run against a fake binding today, but "today" is not
 * a safety property. This runs on every send, in every environment, and is
 * the only thing standing between a stray test run and a burned domain.
 *
 * Two layers:
 *
 * 1. **Reserved domains are refused everywhere, production included.**
 *    RFC 2606 / RFC 6761 set aside `example.com|net|org` and the `.test`,
 *    `.invalid`, `.localhost` and `.local` suffixes precisely so they can
 *    never resolve. Mail to them is guaranteed to bounce, so there is no
 *    environment where sending is the right behaviour.
 *
 * 2. **Outside production, an allowlist.** `EMAIL_MODE=allowlist` sends only
 *    to addresses in `EMAIL_ALLOWLIST`; everything else is recorded and
 *    dropped. Preview talks to the same verified domain as production, so
 *    without this a preview smoke test would mail a real stranger who typed
 *    their address into a listing request.
 *
 * Fails closed: an unset or unrecognised `EMAIL_MODE` sends nothing.
 * Blocked attempts are still written to `email_events` (`ok = 0`) so a
 * silently-dropped notification is visible rather than mysterious.
 *
 * The reserved-domain list itself lives in `@keepsake/contracts/common`
 * (`isReservedEmailDomain`) so the web form that first sees the address and
 * this last-line-of-defence check can never drift apart.
 */
export type GuardDecision = { allowed: true } | { allowed: false; reason: string };

/** Reserved-by-standard domains that can never accept mail. */
export const isReservedDomain = isReservedEmailDomain;

function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

export function guardRecipient(env: Env, to: string): GuardDecision {
  const address = to.trim().toLowerCase();
  const mode = (env.EMAIL_MODE ?? "").trim().toLowerCase();

  // "test" short-circuits everything, including the reserved-domain rule,
  // because the unit suite is built on `@example.com` fixtures and sends them
  // through a fake binding where nothing leaves the process. It is safe only
  // because it can never be set outside vitest: `email-mode-config.test.ts`
  // reads wrangler.toml and fails if this value ever appears there.
  if (mode === "test") return { allowed: true };

  if (address.length === 0 || !address.includes("@")) {
    return { allowed: false, reason: "blocked_invalid_address" };
  }
  if (isReservedDomain(address)) {
    return { allowed: false, reason: "blocked_reserved_domain" };
  }

  if (mode === "live") return { allowed: true };
  if (mode === "allowlist") {
    const allowed = parseAllowlist(env.EMAIL_ALLOWLIST);
    if (allowed.includes(address)) return { allowed: true };
    return { allowed: false, reason: "blocked_not_allowlisted" };
  }
  return { allowed: false, reason: "blocked_email_mode_off" };
}

export type EmailKind =
  | "verify_email"
  | "confirm_request"
  | "new_request"
  | "request_received"
  | "chosen"
  | "recover"
  | "admin_test"
  | "admin_digest";

/**
 * The product question issue #310 raised and this fix does not get to duck:
 * unsubscribing from a CEM cannot mean dropping a message that *is* the
 * transaction the recipient is mid-way through. Every kind in this set is
 * sent either (a) in direct, same-cycle response to something the recipient
 * themselves just did — typed their address to verify it (`verify_email`),
 * submitted a request and needs to confirm it (`confirm_request`) or was
 * told it landed (`request_received`), asked to recover their dashboard
 * (`recover`) — or (b) is the delivery of the outcome of a transaction they
 * already started by requesting something (`chosen`, "you were chosen");
 * or (c) is addressed to the site operator, not a subscriber at all
 * (`admin_test`, `admin_digest`). Suppressing any of these defeats the
 * transaction it belongs to (or, for the admin pair, has no subscriber to
 * honor a preference for in the first place) — exactly the failure mode the
 * issue calls out by name for `chosen` and `confirmRequest`.
 *
 * `new_request` is deliberately **not** in this set. Unlike the six above,
 * its recipient (a listing's owner) did not just take the action this
 * message reports — a stranger did, by asking for something the owner
 * posted — so it is closer to "someone messaged you" than to a receipt for
 * the recipient's own click. The owner's dashboard (`/mine/:id`, already
 * linked from this exact email) shows every open request regardless of
 * whether this notification ever arrives, so suppressing it costs
 * visibility into *when* a new one showed up, not the request itself. It is
 * the one kind this fix can suppress and demonstrate suppressing —
 * `test/emailUnsubscribe.test.ts` — and the unsubscribe page states this
 * exact consequence before anyone confirms (`apps/web/app/unsubscribe/[token].tsx`).
 *
 * A kind added later defaults to **suppressible** by leaving it out of this
 * set, not the other way around — the safer default when nobody has
 * reasoned about a new template yet is that an unsubscribed recipient stops
 * getting it, not that it silently joins the exempt list.
 */
export const TRANSACTIONAL_EMAIL_KINDS: ReadonlySet<EmailKind> = new Set([
  "verify_email",
  "confirm_request",
  "request_received",
  "chosen",
  "recover",
  "admin_test",
  "admin_digest",
]);

export interface MailMessage {
  kind: EmailKind;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export interface SendMailResult {
  sent: boolean;
  /**
   * A *stable* short code — `blocked_reserved_domain`, `send_failed`,
   * `email_binding_missing`, … — never the provider's message. Stable
   * matters twice over: it is what `email_events.error` groups by (a reason
   * that varied per recipient made a systematic refusal fragment into one
   * single-count group per address, hiding the pattern behind noise), and it
   * is the vocabulary `requests.notify_failed_reason` speaks, which sits one
   * boolean away from a giver's screen.
   */
  reason?: string;
  /**
   * The provider's own words, kept whole and kept separate. This is the only
   * thing that distinguishes "the binding refuses unverified destinations"
   * from "that address was a typo" — from the inside those two failures are
   * otherwise identical, which is exactly issue #6. Diagnostic surfaces
   * only: the `email_events` row, `POST /api/admin/test-email`, and the
   * `console.error` line. Never returned to an ordinary end user.
   *
   * Whole, but not verbatim: the recipient's address is replaced with
   * `<recipient>` first (#190). The sentence survives — that is the part with
   * the diagnostic value — and the identifier does not, because `to_hash` is
   * meant to be the only column in that row naming who was mailed. See
   * `scrubProviderDetail`.
   */
  detail?: string;
  /**
   * The `email_events` row this attempt wrote, so a human running the one
   * test that has never been run (a real send to a real external inbox) has
   * an exact row id to look up and paste back rather than guessing which of
   * today's rows was theirs.
   */
  eventId?: string;
}

/**
 * Longer than any error code and shorter than a runaway provider payload.
 * The old 160-char truncation lost the tail of Cloudflare's rejection
 * messages, which is where the actionable half ("... destination address not
 * verified") tends to live.
 */
const MAX_ERROR_DETAIL_CHARS = 1000;

function truncateDetail(text: string): string {
  return text.length > MAX_ERROR_DETAIL_CHARS ? `${text.slice(0, MAX_ERROR_DETAIL_CHARS)}…` : text;
}

/** What the recipient's own address is replaced with in provider text. */
export const RECIPIENT_PLACEHOLDER = "<recipient>";

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Issue #190. SMTP and Email-Routing rejections quote the destination
 * address, so the provider's sentence carried the recipient's plaintext email
 * into `email_events.error_detail` — the column sitting beside the `to_hash`
 * that exists precisely so we never store who was mailed, and the one copy
 * that outlived both the requester's withdraw link and `DELETE /api/me/email`
 * for the 90 days of `orphanSweep`'s retention.
 *
 * Every provider string is scrubbed **here, where it is captured**, not on
 * the way into D1, so all three surfaces the `detail` doc comment names — the
 * `email_events` row, `POST /api/admin/test-email`, and the `console.error`
 * line — are covered by one call. That matters for the log line in
 * particular: it is a direct `console.error`, so it never passes through
 * `redactString` the way `captureException` does.
 *
 * Two passes, in this order:
 *
 *  1. The recipient's own address becomes `<recipient>`. Naming it as the
 *     recipient keeps the entire diagnosis intact — *"… is not a verified
 *     destination address for this Email Routing zone"* still reads as a
 *     sentence, and that sentence is the half that would answer #6 — while
 *     removing the identifier `to_hash` already carries. Case-insensitive,
 *     because the provider may echo a normalised form of what we sent.
 *  2. `redactString` as the backstop, for a *different* address the provider
 *     quotes (a forwarding target, an envelope sender) or a normalisation
 *     step 1 could not match. It keeps the domain, so the provider is still
 *     named. This is the #170 rule; the two fixes are deliberately layered
 *     rather than duplicated.
 */
export function scrubProviderDetail(text: string, to: string): string {
  const address = to.trim();
  const withoutRecipient =
    address.length > 0
      ? text.replace(new RegExp(escapeForRegExp(address), "gi"), RECIPIENT_PLACEHOLDER)
      : text;
  return redactString(withoutRecipient);
}

/**
 * The domain half of an address, lowercased — `null` if there isn't one.
 * `to_hash` remains the only column that identifies *who* was mailed; a bare
 * domain names a mail provider, not a person, and it is the whole difference
 * between "one address bounced" and "every send to this provider is
 * refused".
 */
export function recipientDomain(to: string): string | null {
  const at = to.lastIndexOf("@");
  if (at < 0) return null;
  const domain = to.slice(at + 1).trim().toLowerCase();
  return domain.length > 0 ? domain : null;
}

async function recordEmailEvent(
  env: Env,
  fields: {
    kind: EmailKind;
    toHash: string;
    toDomain: string | null;
    provider: string;
    ok: boolean;
    error?: string;
    errorDetail?: string;
  },
): Promise<string> {
  const id = ulid();
  await env.DB.prepare(
    `INSERT INTO email_events (id, kind, to_hash, to_domain, provider, ok, error, error_detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      fields.kind,
      fields.toHash,
      fields.toDomain,
      fields.provider,
      fields.ok ? 1 : 0,
      fields.error ?? null,
      fields.errorDetail ?? null,
      Date.now(),
    )
    .run();
  return id;
}

async function sendViaCloudflare(env: Env, message: MailMessage, headers: Record<string, string>): Promise<SendMailResult> {
  try {
    await env.EMAIL.send({
      from: env.EMAIL_FROM,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
      ...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
    return { sent: true };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    // The provider's words are the diagnosis and must survive; the reason
    // code stays stable so the rollup can group on it. Folding the two
    // together (as this did before issue #6's second pass) is what made a
    // binding-level refusal indistinguishable from a bad address.
    const detail = truncateDetail(scrubProviderDetail(errorMessage, message.to));
    console.error("sendMail: EMAIL.send failed", { domain: recipientDomain(message.to), error: detail });
    return { sent: false, reason: "send_failed", detail };
  }
}

async function sendViaResend(env: Env, message: MailMessage, headers: Record<string, string>): Promise<SendMailResult> {
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.replyTo !== undefined ? { reply_to: message.replyTo } : {}),
        // Resend's `POST /emails` accepts a `headers` map of raw header
        // name/value pairs, passed through to the outgoing message verbatim
        // — the same shape the `cf` path's `EmailMessageBuilder.headers`
        // takes, so `List-Unsubscribe`/`List-Unsubscribe-Post` work
        // identically on either provider.
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      }),
    });
    if (!response.ok) {
      const body = scrubProviderDetail(await response.text().catch(() => ""), message.to);
      console.error("sendMail: resend request failed", { status: response.status, body: body.slice(0, 200) });
      // The HTTP status is stable enough to group on and is itself a
      // diagnosis (401 = key, 403 = domain, 422 = recipient); the body is
      // detail.
      return {
        sent: false,
        reason: `send_failed_http_${response.status}`,
        detail: truncateDetail(`resend ${response.status}: ${body}`),
      };
    }
    return { sent: true };
  } catch (err) {
    const detail = truncateDetail(scrubProviderDetail(err instanceof Error ? err.message : String(err), message.to));
    console.error("sendMail: resend request threw", { error: detail });
    return { sent: false, reason: "send_failed", detail };
  }
}

/**
 * Fills in `UNSUBSCRIBE_LINK_PLACEHOLDER` in a rendered message's `html` and
 * `text`, and returns the RFC 8058 headers a compliant mail client (or
 * `POST /api/admin/test-email`'s own inspection) can act on. Runs *after*
 * every template has already been rendered, which is exactly why the
 * placeholder exists at all — see `templates/shared.ts`'s doc comment on it.
 *
 * The HTML substitution wraps the URL in a real `<a href>` — the placeholder
 * in the raw template is deliberately plain text (no markup), so
 * `emailPromotionalContent.test.ts`'s link-structure check, which runs
 * against *unsubstituted* template output, never sees a link there to
 * evaluate in the first place. The text substitution is the bare URL, which
 * is all a plain-text part can offer.
 *
 * `unsubscribeWebUrl` — the human-facing page, which states the consequence
 * and asks for a click — is what goes in the footer body a person reads.
 * `unsubscribeApiUrl` — a POST-only route with no page at all — is what goes
 * in `List-Unsubscribe`, because RFC 8058 is answered by a mail client's own
 * "Unsubscribe" affordance, not by rendering Keepsake's page inside it.
 *
 * When `UNSUBSCRIBE_SECRET` isn't configured (`unsubscribe.ts`'s documented
 * fail-open), both URLs come back `null` and this falls back to the
 * `mailto:` address the footer's other CASL line already names — a working,
 * if less convenient, mechanism rather than a dead placeholder shipped
 * verbatim into a real inbox.
 */
async function withUnsubscribeLink(
  env: Env,
  message: MailMessage,
): Promise<{ html: string; text: string; headers: Record<string, string> }> {
  const mailtoFallback = "mailto:hello@keepsake.ing?subject=Unsubscribe";
  const [webUrl, apiUrl] = await Promise.all([unsubscribeWebUrl(env, message.to), unsubscribeApiUrl(env, message.to)]);
  const bodyHref = webUrl ?? mailtoFallback;

  const html = message.html
    .split(UNSUBSCRIBE_LINK_PLACEHOLDER)
    .join(`<a href="${escapeHtmlAttr(bodyHref)}">${escapeHtmlAttr(bodyHref)}</a>`);
  const text = message.text.split(UNSUBSCRIBE_LINK_PLACEHOLDER).join(bodyHref);

  // The body link goes on every message — it is the s.6(2)(c) mechanism, and
  // it works: it suppresses the class of messages that can be suppressed,
  // which is what the footer now says it does.
  //
  // The *headers* do not. `List-Unsubscribe-Post` is a promise to the mail
  // client, not to the reader: it tells Gmail and Yahoo to show their own
  // Unsubscribe button and to treat one press of it as the end of this kind
  // of mail. On a kind `TRANSACTIONAL_EMAIL_KINDS` exempts that promise is
  // one we do not keep — the next `chosen` or `confirm_request` arrives
  // anyway — and a recipient who presses Unsubscribe and keeps hearing from
  // us reaches for the spam button instead, which costs the deliverability
  // of every transactional message the product depends on. So an exempt
  // kind carries `mailto:` alone: a real mechanism, no one-click claim.
  const oneClick = apiUrl !== null && !TRANSACTIONAL_EMAIL_KINDS.has(message.kind);

  const headers: Record<string, string> = {
    // Order matters to some clients that only honor the first entry: the
    // real one-click URL first, `mailto:` as the fallback every client
    // already understands.
    "List-Unsubscribe": [oneClick ? `<${apiUrl}>` : null, `<${mailtoFallback}>`].filter((v): v is string => v !== null).join(", "),
  };
  // Only promise one-click POST semantics when there is a real POST target
  // to promise them against, and only on a kind that press would actually
  // stop.
  if (oneClick) headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";

  return { html, text, headers };
}

/** `href="..."` attribute value escaping — narrower than the templates'
 * `escapeHtml` (`&`/`<`/`>`/`"` only matters inside an attribute value; the
 * URL itself is not markup) but reusing `escapeHtml` here would be correct
 * too. Kept separate only so this file doesn't reach into `templates/` for
 * something this small. */
function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function sendMail(env: Env, message: MailMessage): Promise<SendMailResult> {
  const toHash = await sha256Hex(message.to.toLowerCase());
  const toDomain = recipientDomain(message.to);
  const provider = emailProviderName(env);

  let result: SendMailResult;
  let providerLabel: string;

  const guard = guardRecipient(env, message.to);
  if (!guard.allowed) {
    // Recorded, not thrown: the give/request/choose flow it belongs to must
    // still succeed, and `email_events` is where "why did nothing arrive"
    // gets answered.
    console.log("[email:blocked]", { subject: message.subject, domain: toDomain, reason: guard.reason });
    const eventId = await recordEmailEvent(env, {
      kind: message.kind,
      toHash,
      toDomain,
      provider: "blocked",
      ok: false,
      error: guard.reason,
    });
    return { sent: false, reason: guard.reason, eventId };
  }

  // Suppression, issue #310 part two. Checked after the reputation/reserved-
  // domain guard above (a suppressed address is still a real address; the
  // two gates answer different questions) and before a template's kind
  // decides anything else. `TRANSACTIONAL_EMAIL_KINDS` is the product
  // decision this fix does not duck — see that constant's doc comment for
  // which kinds are exempt and why.
  if (!TRANSACTIONAL_EMAIL_KINDS.has(message.kind) && (await isUnsubscribed(env, message.to))) {
    console.log("[email:suppressed]", { subject: message.subject, domain: toDomain, kind: message.kind });
    const eventId = await recordEmailEvent(env, {
      kind: message.kind,
      toHash,
      toDomain,
      provider: "blocked",
      ok: false,
      error: "blocked_unsubscribed",
    });
    return { sent: false, reason: "blocked_unsubscribed", eventId };
  }

  const { html, text, headers } = await withUnsubscribeLink(env, message);
  const outgoing: MailMessage = { ...message, html, text };

  if (provider === "cf" && env.EMAIL) {
    providerLabel = "cf";
    result = await sendViaCloudflare(env, outgoing, headers);
  } else if (provider === "resend" && env.RESEND_API_KEY) {
    providerLabel = "resend";
    result = await sendViaResend(env, outgoing, headers);
  } else {
    providerLabel = "none";
    const reason = provider === "cf" ? "email_binding_missing" : provider === "resend" ? "resend_key_missing" : "provider_unset";
    // `domain`, not `to`: this line used to print the recipient's plaintext
    // address on the no-binding path, which is the same #190 leak one line
    // away from the one the issue names. Matches `[email:blocked]` above.
    console.log("[email:stub]", { domain: toDomain, subject: message.subject, reason });
    result = { sent: false, reason };
  }

  const eventId = await recordEmailEvent(env, {
    kind: message.kind,
    toHash,
    toDomain,
    provider: providerLabel,
    ok: result.sent,
    ...(result.reason !== undefined ? { error: result.reason } : {}),
    ...(result.detail !== undefined ? { errorDetail: result.detail } : {}),
  });

  return { ...result, eventId };
}

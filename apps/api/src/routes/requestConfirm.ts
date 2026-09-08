/**
 * `POST /api/requests/confirm` — issue #188. The step that turns a held
 * submission into a real request, and the only place in this Worker where an
 * address becomes the requester of record.
 *
 * Reachable only with the single-use token mailed as a link in
 * `confirmRequest` (`src/email/templates/confirmRequest.ts`). That token goes
 * to the submitted address and nowhere else, so presenting it back is the
 * proof of control that `POST /api/listings/:id/requests` never had: exactly
 * the shape `POST /api/recover/:token` and `POST /api/requests/withdraw`
 * already use for people who have no account and never will.
 *
 * Everything the old create path did to the giver's side happens here, and
 * only here:
 *
 *   - the request becomes `open` and starts appearing in the giver's
 *     dashboard;
 *   - `listings.request_count` is incremented;
 *   - the `new_request` mail goes to the giver;
 *   - the withdraw token is minted and mailed, in the `request_received`
 *     confirmation that used to go out unconditionally at submit time.
 *
 * Not `ownerAuth()`-guarded, and no Turnstile: like the withdraw and recover
 * routes, the token in the body *is* the credential, and the person holding
 * it is by construction the one reading mail at the address.
 *
 * No burst brake or daily budget in front of it either, and deliberately so:
 * the same is true of `POST /api/requests/withdraw`, which has the identical
 * exposure. The token is 256 bits from `crypto.getRandomValues`, so guessing
 * one is not a thing a limiter would be protecting against, and every effect
 * this route has — one row, one increment, two mails — is bounded by a
 * submission that already passed Turnstile, the per-IP daily budget and the
 * per-recipient ceiling on the way in. Add a limiter here and the thing it
 * would actually ration is people clicking a link in their own email.
 *
 * A POST from a page, not a GET on the link itself, and for a specific
 * reason: mail clients, link scanners and corporate security proxies fetch
 * URLs out of messages before a human ever sees them. A confirmation that
 * completed on GET would be auto-confirmed by the victim's own mail provider,
 * which would leave the whole flow proving nothing. `apps/web`'s
 * `/confirm/[token]` page is what POSTs here, the same arrangement
 * `/withdraw/[token]` and `/recover/[token]` already use.
 */
import { Hono } from "hono";
import { RequestConfirmInput, type RequestConfirmResult } from "@keepsake/contracts/request";
import type { Env } from "../env.js";
import { ok, fail } from "../lib/respond.js";
import { sha256Hex } from "../lib/digest.js";
import { randomTokenRaw } from "../lib/tokens.js";
import { validateBody } from "../middleware/validate.js";
import { sendMail } from "../email/sendMail.js";
import { newRequest as newRequestTemplate } from "../email/templates/newRequest.js";
import { requestReceived as requestReceivedTemplate } from "../email/templates/requestReceived.js";

type Vars = { validatedBody: RequestConfirmInput };
export const requestConfirmRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

interface ConfirmableRequestRow {
  id: string;
  listing_id: string;
  note: string | null;
  email: string | null;
  status: string;
  confirmed_at: number | null;
  confirm_expires_at: number | null;
}

/**
 * Atomically opens a held request and accounts for it on its listing.
 *
 * The listing predicate belongs in the write, not only in the handler's
 * earlier read. A giver can mark the keepsake given while the confirmation
 * request is in flight; D1 serializes this batch with that write, and the
 * predicate makes whichever write arrives second observe the first. Keeping
 * the counter update in the same batch also prevents a withdrawal from
 * landing between "open" and the increment and leaving a withdrawn request
 * counted forever.
 *
 * Exported so the race guard can be exercised directly, without a timing-
 * dependent pair of HTTP requests.
 */
export async function claimRequestConfirmation(
  env: Env,
  requestId: string,
  now: number,
  withdrawTokenHash: string,
): Promise<boolean> {
  const [claim] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE requests SET status = 'open', confirmed_at = ?, withdraw_token_hash = ?
       WHERE id = ? AND confirmed_at IS NULL
         AND EXISTS (
           SELECT 1 FROM listings
           WHERE listings.id = requests.listing_id AND listings.status = 'approved'
         )`,
    ).bind(now, withdrawTokenHash, requestId),
    env.DB.prepare(
      `UPDATE listings SET request_count = request_count + 1
       WHERE status = 'approved'
         AND EXISTS (
           SELECT 1 FROM requests
           WHERE requests.id = ?
             AND requests.listing_id = listings.id
             AND requests.confirmed_at = ?
             AND requests.withdraw_token_hash = ?
         )`,
    ).bind(requestId, now, withdrawTokenHash),
  ]);

  return (claim?.meta.changes ?? 0) > 0;
}

requestConfirmRoutes.post("/confirm", validateBody(RequestConfirmInput), async (c) => {
  const input = c.get("validatedBody");
  const tokenHash = await sha256Hex(input.token);

  const row = await c.env.DB.prepare(
    `SELECT id, listing_id, note, email, status, confirmed_at, confirm_expires_at
     FROM requests WHERE confirm_token_hash = ?`,
  )
    .bind(tokenHash)
    .first<ConfirmableRequestRow>();

  // Unknown token, a token whose row was swept after expiry, and a typo are
  // one answer — the same posture as `POST /api/requests/withdraw` and
  // `POST /api/recover/:token`, so probing teaches nothing.
  if (!row) {
    return fail(c, "unauthorized", "This link is invalid or has already been used.", 401);
  }

  const now = Date.now();

  // Already confirmed: answer as if this call did it. Clicking twice, a
  // browser reload, and the back button are all ordinary, and telling
  // someone their own confirmation is invalid because it worked the first
  // time is a bug that reads as a broken product. The replay tells its
  // holder only that a link *they already had* was used, which they know.
  if (row.confirmed_at !== null) {
    const result: RequestConfirmResult = {
      id: row.id,
      listing_id: row.listing_id,
      confirmed_at: row.confirmed_at,
      listing_available: row.status === "open" || row.status === "chosen",
    };
    return ok(c, result);
  }

  // Expired is its own answer rather than the undifferentiated 401 above,
  // because unlike an unknown token it is actionable and reveals nothing: the
  // only person who can present an expired token is the one reading mail at
  // the address it was sent to, and "this lapsed, ask again" is what they
  // need to hear. The held row is deleted by `cron/orphanSweep.ts`, after
  // which this token falls through to the 401 above instead.
  if (row.confirm_expires_at !== null && row.confirm_expires_at < now) {
    return fail(c, "gone", "This link has expired. You can ask for the keepsake again.", 410);
  }

  const listing = await c.env.DB.prepare("SELECT id, title, owner_id, status FROM listings WHERE id = ?")
    .bind(row.listing_id)
    .first<{ id: string; title: string; owner_id: string; status: string }>();

  // The keepsake stopped being claimable while the link sat in an inbox —
  // given to someone else, withdrawn, taken down.
  if (listing?.status !== "approved") {
    // Answer honestly and change nothing. Confirming here would leave a
    // proven address and a note stored against a listing nobody can be given,
    // and the only two messages this route sends would both be false: a giver
    // told about a new ask for something they have already given away, and a
    // requester told "we passed your note along" when there was nobody to
    // pass it to.
    //
    // Leaving the row held instead means the nightly sweep erases it, which
    // is the outcome the requester would have chosen anyway. The link stays
    // live until it expires, so if the listing was only temporarily out of
    // view, clicking again later still works.
    const result: RequestConfirmResult = {
      id: row.id,
      listing_id: row.listing_id,
      // Null, not `now`: nothing was confirmed. Reporting a timestamp for a
      // confirmation that did not happen is the kind of small lie that later
      // gets read as fact by something else.
      confirmed_at: null,
      listing_available: false,
    };
    return ok(c, result);
  }

  // The single-use claim is a compare-and-set rather than a read-then-write:
  // two clicks landing in the same second (a client that retries, a
  // double-tap) both reach this line, and exactly one changes the row.
  // Everything with a side effect below — the count, both mails — hangs off
  // that result, so a race cannot double-count a request or mail a giver
  // twice about one ask. The helper also repeats the listing-status check in
  // the write, closing the availability race left by the SELECT above.
  const rawWithdrawToken = randomTokenRaw();
  const withdrawTokenHash = await sha256Hex(rawWithdrawToken);
  const claimed = await claimRequestConfirmation(c.env, row.id, now, withdrawTokenHash);

  if (!claimed) {
    // Either another confirmation won, or the listing stopped being
    // available after the read above. Re-read both facts rather than
    // reporting a confirmation that may never have happened.
    const current = await c.env.DB.prepare(
      `SELECT r.confirmed_at, r.status AS request_status, l.status AS listing_status
       FROM requests r LEFT JOIN listings l ON l.id = r.listing_id
       WHERE r.id = ?`,
    )
      .bind(row.id)
      .first<{ confirmed_at: number | null; request_status: string; listing_status: string | null }>();
    const result: RequestConfirmResult = {
      id: row.id,
      listing_id: row.listing_id,
      confirmed_at: current?.confirmed_at ?? null,
      listing_available:
        current?.confirmed_at !== null &&
        (current?.request_status === "open" || current?.request_status === "chosen") &&
        current?.listing_status === "approved",
    };
    return ok(c, result);
  }

  const owner = await c.env.DB.prepare("SELECT email, email_verified_at, banned_at FROM owners WHERE id = ?")
    .bind(listing.owner_id)
    .first<{ email: string | null; email_verified_at: number | null; banned_at: number | null }>();

  // Same rule the create path used to apply, moved intact: only a giver who
  // has confirmed their own address is mailed. `banned_at` is checked again
  // here because a ban can land between the ask and the confirmation, and a
  // banned owner is not someone this Worker should be delivering strangers'
  // notes to.
  if (owner?.email && owner.email_verified_at !== null && owner.banned_at === null) {
    const dashboardLink = `${c.env.SITE_URL}/mine/${row.listing_id}`;
    const template = newRequestTemplate({ listingTitle: listing.title, note: row.note ?? "", dashboardLink });
    const result = await sendMail(c.env, { kind: "new_request", to: owner.email, ...template });
    if (result.sent) {
      await c.env.DB.prepare("UPDATE requests SET notified_at = ? WHERE id = ?").bind(Date.now(), row.id).run();
    } else {
      // Issue #6, unchanged in substance: recorded on the request itself so
      // the owner dashboard can surface a failed notification next to the ask
      // it belongs to, not just in `email_events`.
      await c.env.DB.prepare("UPDATE requests SET notify_failed_reason = ? WHERE id = ?")
        .bind(result.reason ?? "send_failed", row.id)
        .run();
    }
  }

  // The "we passed your note along" confirmation, which is now true when it
  // is sent — it used to go out at submit time, when nothing had been passed
  // to anyone. It carries the withdraw token, still the requester's only
  // no-account way back in to erase their own note, email and phone
  // (`src/routes/requestWithdraw.ts`).
  if (row.email) {
    const withdrawLink = `${c.env.SITE_URL}/withdraw/${rawWithdrawToken}`;
    await sendMail(c.env, {
      kind: "request_received",
      to: row.email,
      ...requestReceivedTemplate({ listingTitle: listing.title, withdrawLink }),
    });
  }

  const result: RequestConfirmResult = {
    id: row.id,
    listing_id: row.listing_id,
    confirmed_at: now,
    listing_available: true,
  };
  return ok(c, result);
});
